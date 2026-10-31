use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use xdev_core::{CoreError, Store, Vault, index_path, search, sync_vault};

/// Same folder as Tauri's `app_data_dir` for this identifier, so the CLI and
/// the desktop app share one index per vault.
const APP_ID: &str = "asia.xdev.desktop";

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
}

fn main() -> ExitCode {
    match run(Cli::parse().command) {
        Ok(()) => ExitCode::SUCCESS,
        // Codes, not prose, so scripts can match on them.
        Err(code) => {
            eprintln!("error: {code}");
            ExitCode::from(1)
        }
    }
}

fn run(command: Command) -> Result<(), &'static str> {
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
    }
    Ok(())
}

fn data_dir() -> Option<PathBuf> {
    match std::env::var_os("XDEV_DATA_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::data_dir().map(|d| d.join(APP_ID)),
    }
}
