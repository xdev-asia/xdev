use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

use clap::Subcommand;
use serde::Serialize;
use xdev_ai::{
    AccountEntry, AccountStatus, AiError, Quota, Registry, account_dir, claude_command, pick,
    quota, status,
};

use crate::Outcome;

#[derive(Subcommand)]
pub enum AccountsCommand {
    /// Print `name<TAB>provider<TAB>status<TAB>email<TAB>plan` per account.
    List,
    /// Register an account. Without `--dir`, create its folder under the
    /// data dir and sign it in.
    Add {
        name: String,
        /// An existing Claude Code config folder; registered only.
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// Run `claude auth login` for an account; exits with its code.
    Login { name: String },
    /// Unregister an account. Its folder and credentials stay.
    Remove { name: String },
    /// Set the percent of each account kept for the person, 0 to 90.
    Reserve { percent: u32 },
    /// Print the signed-in account with the most room; exits 1 when none.
    Pick,
}

pub fn run(command: AccountsCommand, data_dir: &Path) -> Result<Outcome, &'static str> {
    let mut reg = Registry::load(data_dir).map_err(code)?;
    match command {
        AccountsCommand::List => {
            for (entry, status) in statuses(&reg.accounts) {
                let state = text(&status.state);
                let email = status.email.as_deref().unwrap_or("-");
                let plan = status.plan.as_deref().unwrap_or("-");
                println!("{}\tclaude\t{state}\t{email}\t{plan}", entry.name);
            }
        }
        AccountsCommand::Add {
            name,
            dir: Some(dir),
        } => {
            // Stored absolute so the registry means the same from any folder.
            let dir = std::path::absolute(&dir).map_err(|_| "io")?;
            reg.add(&name, dir).map_err(code)?;
            reg.save(data_dir).map_err(code)?;
        }
        AccountsCommand::Add { name, dir: None } => {
            let dir = account_dir(data_dir, &name);
            let entry = reg.add(&name, dir.clone()).map_err(code)?.clone();
            // Checked before anything is written, so a failed add leaves no
            // half-made account behind.
            claude_command().map_err(code)?;
            fs::create_dir_all(&dir).map_err(|_| "io")?;
            reg.save(data_dir).map_err(code)?;
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
        AccountsCommand::Pick => {
            let quotas: Vec<_> = quotas(&reg)
                .into_iter()
                .map(|(_, status, quota)| (status, quota))
                .collect();
            match pick(&quotas) {
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
    let quotas: Vec<Quota> = quotas(&reg).into_iter().map(|(_, _, q)| q).collect();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&quotas).map_err(|_| "io")?
        );
        return Ok(Outcome::Ok);
    }
    for quota in &quotas {
        let mut line = format!("{}\t{}", quota.name, text(&quota.state));
        for window in &quota.windows {
            match window.utilization {
                Some(percent) => line.push_str(&format!("\t{}={percent}", window.key)),
                None => line.push_str(&format!("\t{}=-", window.key)),
            }
        }
        let reason = quota.reason.as_ref().map_or("-".to_owned(), text);
        println!("{line}\t{reason}");
    }
    Ok(Outcome::Ok)
}

fn login(entry: &AccountEntry) -> Result<Outcome, &'static str> {
    let status = claude_command()
        .map_err(code)?
        .args(["auth", "login"])
        .env("CLAUDE_CONFIG_DIR", &entry.dir)
        .status()
        .map_err(|_| "io")?;
    if status.success() {
        return Ok(Outcome::Ok);
    }
    // Claude Code has already said what went wrong; only pass its code on.
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
