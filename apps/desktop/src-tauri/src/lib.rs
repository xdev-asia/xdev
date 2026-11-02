mod commands;
mod session;
mod settings;

use commands::AppState;

#[tauri::command]
fn app_version() -> String {
    xdev_core::version().to_string()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            session: Default::default(),
            // Resolved by core, not Tauri, so it honours `XDEV_DATA_DIR`
            // exactly like the CLI and both share one index.
            data_dir: xdev_core::data_dir(),
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            commands::open_vault,
            commands::last_vault,
            commands::list_docs,
            commands::read_doc,
            commands::write_doc,
            commands::search,
            commands::vcs_state,
            commands::init_repo,
            commands::list_changes,
            commands::read_base,
            commands::approve,
            commands::reject,
            commands::history,
            commands::read_version,
            commands::restore_version,
            commands::backlinks,
            commands::doc_freshness,
            commands::stale_docs,
            commands::export_plan,
            commands::export_write,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start xDev");
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_version_matches_core() {
        assert_eq!(super::app_version(), xdev_core::version());
    }

    #[test]
    fn identifier_matches_core_app_id() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], xdev_core::APP_ID);
    }
}
