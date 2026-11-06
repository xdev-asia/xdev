use std::path::{Path, PathBuf};
use std::thread;

use clap::Subcommand;
use serde::Serialize;
use xdev_ai::{
    AccountEntry, AccountStatus, AiError, Provider, Quota, Registry, pick, quota, status,
};

use crate::Outcome;

#[derive(Subcommand)]
pub enum AccountsCommand {
    /// Print `name<TAB>provider<TAB>status<TAB>email<TAB>plan` per account.
    List,
    /// Register an account. Without `--dir`, create its folder under the
    /// data dir and sign it in. A single-account provider (`qwen-code`,
    /// `opencode`, `amp`, `cursor`) registers its CLI's own sign-in once and
    /// prints `name<TAB>folder`; sign in with the CLI itself.
    Add {
        name: String,
        /// `claude`, `codex`, `gemini`, `qwen-code`, `opencode`, `amp` or
        /// `cursor`.
        #[arg(long, default_value = "claude")]
        provider: String,
        /// An existing config folder of the provider; registered only. Not for
        /// a single-account provider.
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// Run the provider's sign-in (`claude auth login`, `codex login`, or
    /// `gemini` itself) for an account; exits with its code.
    Login { name: String },
    /// Unregister an account. Its folder and credentials stay.
    Remove { name: String },
    /// Set the percent of each account kept for the person, 0 to 90.
    Reserve { percent: u32 },
    /// Print the signed-in account with the most room; exits 1 when none.
    Pick {
        /// Only consider accounts of this provider.
        #[arg(long)]
        provider: Option<String>,
    },
}

pub fn run(command: AccountsCommand, data_dir: &Path) -> Result<Outcome, &'static str> {
    let mut reg = Registry::load(data_dir).map_err(code)?;
    match command {
        AccountsCommand::List => {
            for (entry, status) in statuses(&reg.accounts) {
                let state = text(&status.state);
                let email = status.email.as_deref().unwrap_or("-");
                let plan = status.plan.as_deref().unwrap_or("-");
                let provider = entry.provider.as_str();
                println!("{}\t{provider}\t{state}\t{email}\t{plan}", entry.name);
            }
        }
        AccountsCommand::Add {
            name,
            provider,
            dir: Some(dir),
        } => {
            let provider = Provider::parse(&provider).map_err(code)?;
            // A single-account CLI has no variable to point at the folder.
            if !provider.isolated() {
                return Err("single_account");
            }
            // Stored absolute so the registry means the same from any folder.
            let dir = std::path::absolute(&dir).map_err(|_| "io")?;
            reg.add(&name, provider, dir).map_err(code)?;
            reg.save(data_dir).map_err(code)?;
        }
        AccountsCommand::Add {
            name,
            provider,
            dir: None,
        } => {
            let provider = Provider::parse(&provider).map_err(code)?;
            let entry = reg.create(data_dir, &name, provider).map_err(code)?;
            reg.save(data_dir).map_err(code)?;
            if !provider.isolated() {
                // Its CLI's own sign-in, which the person signs in to there.
                println!("{}\t{}", entry.name, entry.dir.display());
                return Ok(Outcome::Ok);
            }
            return login(&entry);
        }
        AccountsCommand::Login { name } => {
            let entry = reg.get(&name).ok_or("not_found")?;
            return login(entry);
        }
        AccountsCommand::Remove { name } => {
            let entry = reg.remove(&name).map_err(code)?;
            reg.save(data_dir).map_err(code)?;
            println!(
                "removed {} (folder kept: {})",
                entry.name,
                entry.dir.display()
            );
        }
        AccountsCommand::Reserve { percent } => {
            let percent = u8::try_from(percent).map_err(|_| "bad_reserve")?;
            reg.set_reserve(percent).map_err(code)?;
            reg.save(data_dir).map_err(code)?;
        }
        AccountsCommand::Pick { provider } => {
            let provider = provider
                .as_deref()
                .map(Provider::parse)
                .transpose()
                .map_err(code)?;
            let quotas: Vec<_> = quotas(&reg)
                .into_iter()
                .map(|(entry, status, quota)| (entry.provider, status, quota))
                .collect();
            match pick(&quotas, provider) {
                Some(name) => println!("{name}"),
                None => return Ok(Outcome::Found),
            }
        }
    }
    Ok(Outcome::Ok)
}

/// `xdev quota`: one line per account, or the desktop's `Quota[]` as JSON.
pub fn run_quota(json: bool, data_dir: &Path) -> Result<Outcome, &'static str> {
    let reg = Registry::load(data_dir).map_err(code)?;
    let quotas: Vec<(Provider, Quota)> = quotas(&reg)
        .into_iter()
        .map(|(entry, _, q)| (entry.provider, q))
        .collect();
    if json {
        let quotas: Vec<&Quota> = quotas.iter().map(|(_, q)| q).collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&quotas).map_err(|_| "io")?
        );
        return Ok(Outcome::Ok);
    }
    for (provider, quota) in &quotas {
        let mut line = format!(
            "{}\t{}\t{}",
            quota.name,
            provider.as_str(),
            text(&quota.state)
        );
        for window in &quota.windows {
            match window.utilization {
                Some(percent) => line.push_str(&format!("\t{}={percent}", window.key)),
                None => line.push_str(&format!("\t{}=-", window.key)),
            }
        }
        if let Some(as_of) = &quota.as_of {
            line.push_str(&format!("\tas_of={as_of}"));
        }
        let reason = quota.reason.as_ref().map_or("-".to_owned(), text);
        println!("{line}\t{reason}");
    }
    Ok(Outcome::Ok)
}

fn login(entry: &AccountEntry) -> Result<Outcome, &'static str> {
    let status = xdev_ai::login_process(entry)
        .map_err(code)?
        .status()
        .map_err(|_| "io")?;
    if status.success() {
        return Ok(Outcome::Ok);
    }
    // The CLI has already said what went wrong; only pass its code on.
    let code = status
        .code()
        .and_then(|c| u8::try_from(c).ok())
        .filter(|c| *c != 0)
        .unwrap_or(1);
    Ok(Outcome::Exit(code))
}

/// Each account is a separate process and maybe an HTTP call, so they run
/// side by side rather than one after another.
fn statuses(accounts: &[AccountEntry]) -> Vec<(&AccountEntry, AccountStatus)> {
    thread::scope(|s| {
        let handles: Vec<_> = accounts
            .iter()
            .map(|entry| s.spawn(move || (entry, status(entry))))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

fn quotas(reg: &Registry) -> Vec<(&AccountEntry, AccountStatus, Quota)> {
    let reserve = reg.reserve_percent;
    thread::scope(|s| {
        let handles: Vec<_> = reg
            .accounts
            .iter()
            .map(|entry| {
                s.spawn(move || {
                    let status = status(entry);
                    let quota = quota(entry, &status, reserve);
                    (entry, status, quota)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

/// The serde name of a unit variant, which is the code the spec prints.
fn text<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "-".to_owned())
}

fn code(e: AiError) -> &'static str {
    e.code()
}
