mod accounts;
#[cfg(test)]
mod bindings;
mod commands;
mod kit;
mod pty;
mod session;
mod settings;
mod ship;
mod squads;
mod tasks;
mod updater;
mod workspace;

use commands::AppState;
use tauri::Manager;

#[tauri::command]
fn app_version() -> String {
    xdev_core::version().to_string()
}

pub fn run() {
    // Resolved by core, not Tauri, so they honour `XDEV_DATA_DIR` and
    // `XDEV_LOCAL_DIR` exactly like the CLI and both share one index.
    let data_dir = xdev_core::data_dir();
    let local_dir = xdev_core::local_dir();
    if let (Some(data), Some(local)) = (&data_dir, &local_dir) {
        xdev_core::move_indexes(data, local);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(updater::Pending::default())
        .manage(pty::Ptys::default())
        .manage(workspace::WorkspaceLock::default())
        .setup(|app| {
            updater::start(app.handle().clone());
            Ok(())
        })
        .manage(AppState {
            session: Default::default(),
            data_dir,
            local_dir,
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            updater::update_status,
            updater::update_restart,
            updater::update_notify,
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
            accounts::routing_get,
            accounts::routing_set,
            accounts::routing_models,
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
            pty::pty_spawn,
            pty::pty_approve,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            workspace::workspace_list,
            workspace::repo_add,
            workspace::repo_forget,
            workspace::worktree_create,
            workspace::worktree_pin,
            workspace::worktree_remove,
            workspace::worktree_changes,
            workspace::worktree_stat,
            workspace::worktree_file_diff,
            workspace::worktree_commit,
            workspace::worktree_list_dir,
            ship::worktree_ship,
            ship::worktree_push,
            ship::worktree_pull,
            ship::worktree_sync,
            ship::worktree_fetch,
            ship::worktree_force_push,
            ship::worktree_amend,
            ship::worktree_pr,
            ship::worktree_pr_create,
            ship::worktree_pr_checks,
            ship::worktree_pr_open,
            ship::worktree_draft_commit,
            ship::worktree_draft_pr,
            kit::kit_homes,
            kit::kit_skills,
            kit::kit_memory,
            kit::kit_read,
            kit::kit_write,
            kit::kit_copy,
            kit::kit_skill_copy,
            kit::kit_skill_new,
            kit::kit_skill_remove,
            kit::kit_skill_restore,
            kit::kit_usage,
            kit::kit_paths_exist,
            kit::kit_prompt_history,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start xDev")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::Ptys>().kill_all();
                updater::install_pending(app);
            }
        });
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
