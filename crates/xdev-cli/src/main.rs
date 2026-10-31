use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use xdev_core::{
    ChangeKind, CoreError, FileStatus, Repo, Store, Vault, Written, broken_links, data_dir,
    export_plan, export_root, export_write, index_path, list_changes, search, sync_vault,
};

#[derive(Parser)]
#[command(name = "xdev", version = xdev_core::version(), about = "Local-first project knowledge for humans and AI agents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Index every Markdown file in a folder.
    Index { dir: PathBuf },
    /// Index a folder, then print `path<TAB>title` for each match.
    Search {
        dir: PathBuf,
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Print `kind<TAB>path` for each doc that differs from git `HEAD`.
    Changes { dir: PathBuf },
    /// Index a folder, then print `path<TAB>target` for each broken link;
    /// exits 1 when there is any.
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
}

/// What a command that ran to the end reports through the exit code.
enum Outcome {
    Ok,
    /// The command worked and found problems, already printed.
    Found,
}

fn main() -> ExitCode {
    match run(Cli::parse().command) {
        Ok(Outcome::Ok) => ExitCode::SUCCESS,
        Ok(Outcome::Found) => ExitCode::from(1),
        // Codes, not prose, so scripts can match on them.
        Err(code) => {
            eprintln!("error: {code}");
            ExitCode::from(1)
        }
    }
}

fn run(command: Command) -> Result<Outcome, &'static str> {
    let data_dir = data_dir().ok_or("io")?;
    let open = |dir: &PathBuf| -> Result<(Vault, Store), CoreError> {
        let vault = Vault::open(dir)?;
        let store = Store::open(&index_path(&data_dir, &vault))?;
        Ok((vault, store))
    };
    match command {
        Command::Index { dir } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            let entries = sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            let skipped = entries.iter().filter(|e| e.skipped.is_some()).count();
            println!(
                "indexed {} docs, skipped {skipped}",
                entries.len() - skipped
            );
        }
        Command::Search { dir, query, limit } => {
            let (vault, mut store) = open(&dir).map_err(|e| e.code())?;
            sync_vault(&vault, &mut store).map_err(|e| e.code())?;
            for hit in search(&store, &query, limit).map_err(|e| e.code())? {
                println!("{}\t{}", hit.path, hit.title);
            }
        }
        Command::Changes { dir } => {
            let vault = Vault::open(&dir).map_err(|e| e.code())?;
            let repo = Repo::discover(vault.root()).map_err(|e| e.code())?;
            // A fresh process has written nothing, so every change is
            // `outside`; only the kind is printed.
            let changes = list_changes(&vault, &repo, &Written::new()).map_err(|e| e.code())?;
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
            for link in &broken {
                println!("{}\t{}", link.from, link.target);
            }
            if !broken.is_empty() {
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
