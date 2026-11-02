mod accounts;
#[cfg(test)]
mod bindings;
mod commands;
mod session;
mod settings;
mod squads;
mod tasks;

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
            commands::vault_setup,
            commands::dismiss_vault_prompt,
            commands::create_vault,
            commands::list_docs,
            commands::read_doc,
            commands::write_doc,
            commands::create_doc,
            commands::cli_path,
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
            accounts::accounts_list,
            accounts::accounts_quota,
            accounts::account_add,
            accounts::account_login,
            accounts::account_remove,
            tasks::tasks_context,
            tasks::tasks_list,
            tasks::task_get,
            tasks::task_new,
            tasks::task_run,
            tasks::task_resume,
            tasks::task_approve,
            tasks::task_discard,
            tasks::task_file_diff,
            squads::squads_list,
            squads::squad_get,
            squads::squad_new,
            squads::squad_set_seat,
            squads::squad_remove,
            squads::squad_run,
            squads::squad_answer,
            squads::squad_steer,
            squads::squad_resume,
            squads::squad_stop,
            squads::squad_events,
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
