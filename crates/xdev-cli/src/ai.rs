use std::fs;
use std::io;
use std::path::Path;

use clap::Subcommand;
use xdev_ai::ollama::Ollama;
use xdev_ai::secrets::{Keychain, MemoryStore, PROVIDERS, SecretStore, validate_provider};

use crate::Outcome;

#[derive(Subcommand)]
pub enum AiCommand {
    /// Store API keys in the OS keychain.
    Key {
        #[command(subcommand)]
        command: KeyCommand,
    },
    /// Print one local Ollama model per line.
    Models,
}

#[derive(Subcommand)]
pub enum KeyCommand {
    /// Read one trimmed key from stdin.
    Set { provider: String },
    /// Print `provider<TAB>set|unset`.
    List,
    /// Remove a stored key.
    Remove { provider: String },
}

pub fn run(command: AiCommand, data_dir: &Path) -> Result<Outcome, &'static str> {
    let AiCommand::Key { command } = command else {
        for model in Ollama::default().models().map_err(|e| e.code())? {
            println!("{model}");
        }
        return Ok(Outcome::Ok);
    };
    if let KeyCommand::Set { provider } | KeyCommand::Remove { provider } = &command {
        validate_provider(provider).map_err(|e| e.code())?;
    }
    // Tests need persistence across CLI processes without touching the OS keychain.
    if std::env::var("XDEV_SECRETS").as_deref() == Ok("memory") {
        let path = data_dir.join("test-secrets.json");
        let mut store = MemoryStore::default();
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => "{}".to_owned(),
            Err(_) => return Err("io"),
        };
        let keys: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&text).map_err(|_| "secret_store")?;
        for (provider, key) in keys {
            store.set(&provider, &key).map_err(|e| e.code())?;
        }
        let changes = !matches!(command, KeyCommand::List);
        run_key(command, &mut store)?;
        if changes {
            let mut keys = std::collections::BTreeMap::new();
            for provider in PROVIDERS {
                if let Some(key) = store.get(provider).map_err(|e| e.code())? {
                    keys.insert(provider, key.expose().to_owned());
                }
            }
            fs::create_dir_all(data_dir).map_err(|_| "io")?;
            fs::write(path, serde_json::to_vec(&keys).map_err(|_| "secret_store")?)
                .map_err(|_| "io")?;
        }
    } else {
        run_key(command, &mut Keychain)?;
    }
    Ok(Outcome::Ok)
}

fn run_key(command: KeyCommand, store: &mut dyn SecretStore) -> Result<(), &'static str> {
    match command {
        KeyCommand::Set { provider } => {
            let mut key = String::new();
            io::stdin().read_line(&mut key).map_err(|_| "io")?;
            store.set(&provider, key.trim()).map_err(|e| e.code())?;
        }
        KeyCommand::List => {
            for (provider, set) in store.list().map_err(|e| e.code())? {
                println!("{provider}\t{}", if set { "set" } else { "unset" });
            }
        }
        KeyCommand::Remove { provider } => {
            store.remove(&provider).map_err(|e| e.code())?;
        }
    }
    Ok(())
}
