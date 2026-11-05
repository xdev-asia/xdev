mod accounts;
mod agent;
mod agent_hook;
mod ai;
mod app;
mod context;
mod mcp;
mod orch;
mod skills;
mod squad;
mod task;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use xdev_core::{
    ChangeKind, CoreError, DocState, FileStatus, GitError, Links, Repo, Store, Vault, Written,
    ai_writes, broken_links, data_dir, export_plan, export_root, export_write, index_path,
    list_changes, local_dir, move_indexes, parse_frontmatter, search, stale_docs, sync_vault,
};

#[derive(Parser)]
#[command(name = "xdev", version = xdev_core::version(), about = "Local-first project knowledge for humans and AI agents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// API keys and local Ollama models.
    Ai {
        #[command(subcommand)]
        command: ai::AiCommand,
    },
    /// Index every Markdown file in a folder.
    Index { dir: PathBuf },
    /// Index a folder, then print `path<TAB>title` for each match.
    Search {
        dir: PathBuf,
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Embed changed sections with a local Ollama model.
    Embed {
        dir: PathBuf,
        #[arg(long)]
        model: Option<String>,
    },
    /// Retrieve ranked sections within a character budget.
    Context {
        dir: PathBuf,
        query: String,
        #[arg(long, default_value_t = 8000)]
        budget: usize,
        #[arg(long)]
        json: bool,
    },
    /// Print `kind<TAB>path` for each doc that differs from git `HEAD`.
    Changes { dir: PathBuf },
    /// Index a folder, then print `kind<TAB>path<TAB>detail` for each broken
    /// link and each stale, unverified, unlinked or unknown doc; exits 1 when
    /// there is any.
    Check { dir: PathBuf },
    /// Write AGENTS.md, CLAUDE.md, GEMINI.md and the Cursor rule from the
    /// docs marked for agents; prints `status<TAB>path` per file.
    Export {
        dir: PathBuf,
        /// Folder to write into; default is the git repo root, else `dir`.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Write nothing; exit 1 when any file is new, changed or foreign.
        #[arg(long)]
        check: bool,
    },
    /// Serve a folder to AI agents over MCP on stdin/stdout; default
    /// `./docs` when it is a folder, else the current folder.
    Mcp { dir: Option<PathBuf> },
    /// Claude Code and Codex accounts on this machine.
    Accounts {
        #[command(subcommand)]
        command: accounts::AccountsCommand,
    },
    /// Print `name<TAB>provider<TAB>state<TAB>window=percent...[<TAB>as_of=time]<TAB>reason`
    /// per account.
    Quota {
        /// Print the accounts' quota as a JSON array instead.
        #[arg(long)]
        json: bool,
    },
    /// A coding agent's task in its own git worktree, merged only on
    /// approval.
    Task {
        #[command(subcommand)]
        command: task::TaskCommand,
    },
    /// A team of agents, one per seat, working one task together.
    Squad {
        #[command(subcommand)]
        command: squad::SquadCommand,
    },
    /// Agent CLI integration: `hooks status|on|off`.
    Agent {
        #[command(subcommand)]
        command: agent::AgentCommand,
    },
    /// The running app: version, worktree in front, tab counts. Exit 3
    /// when xDev is not running.
    Status(app::StatusArgs),
    /// Worktrees of the running app: `ps`, `current`, `create`, `set`.
    Worktree {
        #[command(subcommand)]
        command: app::WorktreeCommand,
    },
    /// Terminal tabs of the running app: `list`, `wait`.
    Terminal {
        #[command(subcommand)]
        command: app::TerminalCommand,
    },
    /// Bundled guides and skills: `list`, `get`, `install`, `update`, `installed`.
    Skills {
        #[command(subcommand)]
        command: skills::SkillsCommand,
    },
    /// Coordinate agents in other tabs: runs, tasks, workers and mail.
    #[command(alias = "orch")]
    Orchestration(orch::OrchArgs),
    /// Run by an agent CLI's hook: records the event for the xDev pane in
    /// `XDEV_PTY_ID`. Always exits 0 and prints nothing to stdout.
    #[command(name = "agent-hook", hide = true)]
    AgentHook {
        event: agent_hook::Event,
        /// Whatever the CLI appends; codex `notify` passes its JSON last.
        /// `attention --message <text>` shows the text with the attention.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        rest: Vec<String>,
    },
}

/// What a command that ran to the end reports through the exit code.
enum Outcome {
    Ok,
    /// The command worked and found problems, already printed.
    Found,
    /// A child process's own exit code, passed on.
    Exit(u8),
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        // A hook must never fail the agent's turn, not even on a bad call.
        Err(e) if std::env::args().nth(1).as_deref() == Some(agent_hook::NAME) => {
            eprintln!("xdev agent-hook: {}", e.kind());
            return ExitCode::SUCCESS;
        }
        Err(e) => e.exit(),
    };
    if let Command::AgentHook { event, rest } = cli.command {
        agent_hook::run(event, &rest);
        return ExitCode::SUCCESS;
    }
    let app_cmd = match cli.command {
        Command::Status(a) => app::AppCommand::Status(a),
        Command::Worktree { command } => app::AppCommand::Worktree(command),
        Command::Terminal { command } => app::AppCommand::Terminal(command),
        Command::Orchestration(a) => app::AppCommand::Orchestration(Box::new(a)),
        other => return finish(run(other)),
    };
    // The app verbs need only the local folder, where the endpoint lives.
    let Some(local) = local_dir() else {
        eprintln!("error: io");
        return ExitCode::from(1);
    };
    ExitCode::from(app::run(&app_cmd, &xdev_ipc::app_dir(&local), app::PREFIX))
}

fn finish(outcome: Result<Outcome, &'static str>) -> ExitCode {
    match outcome {
        Ok(Outcome::Ok) => ExitCode::SUCCESS,
        Ok(Outcome::Found) => ExitCode::from(1),
        Ok(Outcome::Exit(code)) => ExitCode::from(code),
        // Codes, not prose, so scripts can match on them.
        Err(code) => {
            eprintln!("error: {code}");
            ExitCode::from(1)
        }
    }
}

fn run(command: Command) -> Result<Outcome, &'static str> {
    let data_dir = data_dir().ok_or("io")?;
    let local_dir = local_dir().ok_or("io")?;
    move_indexes(&data_dir, &local_dir);
    let open = |dir: &PathBuf| -> Result<(Vault, Store), CoreError> {
        let vault = Vault::open(dir)?;
        let store = Store::open(&index_path(&local_dir, &vault))?;
        Ok((vault, store))
    };
    match command {
        Command::Ai { command } => return ai::run(command, &data_dir),
        Command::Accounts { command } => return accounts::run(command, &data_dir),
        Command::Quota { json } => return accounts::run_quota(json, &data_dir),
        Command::Agent { command } => return agent::run(command, &local_dir),
        Command::Task { command } => return task::run(command, &data_dir, &local_dir),
        Command::Squad { command } => return squad::run(command, &data_dir, &local_dir),
        Command::Skills { command } => return skills::run(command, &data_dir),
        // Handled in `main` before any folder is touched.
        Command::AgentHook { .. }
        | Command::Status(_)
        | Command::Orchestration(_)
        | Command::Worktree { .. }
        | Command::Terminal { .. } => return Ok(Outcome::Ok),
        Command::Mcp { dir } => {
            let dir = dir.unwrap_or_else(|| {
                let docs = PathBuf::from("docs");
                if docs.is_dir() {
                    docs
                } else {
                    PathBuf::from(".")
                }
            });
            let (vault, store) = open(&dir).map_err(|e| e.code())?;
            mcp::run(vault, store)?;
        }
        Command::Index { dir } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            let entries = sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            let skipped = entries.iter().filter(|e| e.skipped.is_some()).count();
            println!(
                "indexed {} docs, skipped {skipped}",
                entries.len() - skipped
            );
        }
        Command::Embed { dir, model } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            let stats = store
                .embed_vault(&context::OllamaEmbedder::new(model))
                .map_err(context::error_code)?;
            println!(
                "embedded\t{}\nkept\t{}\nremoved\t{}",
                stats.embedded, stats.kept, stats.removed
            );
        }
        Command::Context {
            dir,
            query,
            budget,
            json,
        } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            let pack = context::pack(&vault, &store, &query, budget)?;
            if json {
                println!("{}", serde_json::to_string(&pack).map_err(|_| "io")?);
            } else {
                print!("{}", context::markdown(&pack));
                if pack.mode == "keyword" {
                    eprintln!("mode: keyword");
                }
            }
        }
        Command::Search { dir, query, limit } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            for hit in search(&store, &query, limit).map_err(|e| e.code())? {
                println!("{}\t{}", hit.path, hit.title);
            }
        }
        Command::Changes { dir } => {
            let (vault, store) = open(&dir).map_err(|e| e.code())?;
            let repo = Repo::discover(vault.root()).map_err(|e| e.code())?;
            // A fresh process has written nothing, so no change is `app`;
            // only the kind is printed.
            let ai = ai_writes(&store).map_err(|e| e.code())?;
            let changes =
                list_changes(&vault, &repo, &Written::new(), &ai).map_err(|e| e.code())?;
            for change in changes {
                let kind = match change.kind {
                    ChangeKind::Added => "added",
                    ChangeKind::Modified => "modified",
                    ChangeKind::Deleted => "deleted",
                };
                println!("{kind}\t{}", change.path);
            }
        }
        Command::Check { dir } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            let broken = broken_links(&vault, &store).map_err(|e| e.code())?;
            // Outside git every covered doc is `unknown`, which fails the
            // check; any other git failure must not pass silently either.
            let repo = match Repo::discover(vault.root()) {
                Ok(repo) => Some(repo),
                Err(GitError::NoRepo) => None,
                Err(e) => return Err(e.code()),
            };
            let stale =
                stale_docs(&vault, repo.as_ref(), &Links::default()).map_err(|e| e.code())?;
            for link in &broken {
                println!("broken\t{}\t{}", link.from, link.target);
            }
            for doc in &stale {
                let (kind, detail) = match doc.state {
                    DocState::Stale => ("stale", doc.count.to_string()),
                    DocState::Unverified => ("unverified", "-".to_owned()),
                    DocState::Unlinked => ("unlinked", "-".to_owned()),
                    _ => ("unknown", verified(&vault, &doc.path)),
                };
                println!("{kind}\t{}\t{detail}", doc.path);
            }
            if !broken.is_empty() || !stale.is_empty() {
                return Ok(Outcome::Found);
            }
        }
        Command::Export { dir, out, check } => {
            let vault = Vault::open(&dir).map_err(|e| e.code())?;
            let root = match out {
                // Canonical like the vault root, so the doc paths inside
                // the files can be made relative to it.
                Some(out) => std::fs::canonicalize(&out).unwrap_or(out),
                None => export_root(&vault).map_err(|e| e.code())?,
            };
            let plan = export_plan(&vault, &root).map_err(|e| e.code())?;
            for file in &plan.files {
                let status = match file.status {
                    FileStatus::New => "new",
                    FileStatus::Changed => "changed",
                    FileStatus::Unchanged => "unchanged",
                    FileStatus::Foreign => "foreign",
                };
                println!("{status}	{}", file.path);
            }
            let pending: Vec<(String, String)> = plan
                .files
                .iter()
                .filter(|f| matches!(f.status, FileStatus::New | FileStatus::Changed))
                .map(|f| (f.path.clone(), f.hash.clone()))
                .collect();
            if check {
                let foreign = plan.files.iter().any(|f| f.status == FileStatus::Foreign);
                if foreign || !pending.is_empty() {
                    return Ok(Outcome::Found);
                }
            } else {
                // Same guard as the app, against a doc saved between the
                // plan and the write.
                export_write(&vault, &root, &pending).map_err(|e| e.code())?;
            }
        }
    }
    Ok(Outcome::Ok)
}

/// The `verified` value an `unknown` doc names, so CI shows which commit is
/// missing from its checkout.
fn verified(vault: &Vault, path: &str) -> String {
    let content = vault.read(path).unwrap_or_default();
    parse_frontmatter(&content)
        .0
        .verified
        .unwrap_or_else(|| "-".to_owned())
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    use xdev_orch::guide::BUNDLED;

    use super::Cli;

    /// Every code-fenced line that starts with `xdev `, `<x>` placeholders
    /// replaced by `x`.
    fn command_lines(text: &str) -> Vec<String> {
        let mut fenced = false;
        let mut out = Vec::new();
        for line in text.lines() {
            if line.trim_start().starts_with("```") {
                fenced = !fenced;
            } else if fenced && line.starts_with("xdev ") {
                let mut s = String::new();
                let mut skip = false;
                for c in line.chars() {
                    match c {
                        '<' => {
                            skip = true;
                            s.push('x');
                        }
                        '>' => skip = false,
                        _ if skip => {}
                        _ => s.push(c),
                    }
                }
                out.push(s);
            }
        }
        out
    }

    #[test]
    fn every_xdev_line_in_the_bundled_guides_parses() {
        let mut seen = 0;
        for b in &BUNDLED {
            let texts = [b.main]
                .into_iter()
                .chain(b.references.iter().map(|(_, t)| *t));
            for text in texts {
                for line in command_lines(text) {
                    let words: Vec<&str> = line.split_whitespace().collect();
                    if let Err(e) = Cli::try_parse_from(&words) {
                        panic!("{}: `{line}` does not parse: {e}", b.topic);
                    }
                    seen += 1;
                }
            }
        }
        assert!(seen >= 10, "only {seen} command lines found");
    }
}
