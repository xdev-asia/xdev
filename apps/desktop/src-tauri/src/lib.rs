mod accounts;
mod agent_sessions;
#[cfg(test)]
mod bindings;
mod commands;
mod hooks;
mod kit;
mod links;
mod profiles;
mod pty;
mod review;
mod review_notes;
mod session;
mod settings;
mod settings_store;
mod ship;
mod squads;
mod status;
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
    let sync_local = local_dir.clone();
    let hooks_dir = local_dir
        .as_ref()
        .map(|local| local.join(xdev_agent::HOOKS_DIR));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(updater::Pending::default())
        .manage(pty::Ptys::default())
        .manage(workspace::WorkspaceLock::default())
        .manage(review_notes::ReviewNotesLock::default())
        .manage(profiles::ProfilesLock::default())
        .manage(status::Shown::default())
        .setup(move |app| {
            updater::start(app.handle().clone());
            // Every settings read and write goes through this store.
            if let Some(file) = commands::settings_path(app.handle()) {
                app.manage(settings_store::SettingsStore::new(file));
            }
            // The `.off` marker follows the stored setting from the start,
            // not only once the setting is saved. Best effort.
            if let (Some(store), Some(local)) = (settings_store::store(app.handle()), &sync_local)
                && let Err(e) = status::sync_hooks_marker(&store, local)
            {
                eprintln!("hooks marker: {e}");
            }
            status::listen_clicks(app.handle());
            // Without the watcher panes still run; they just show no status.
            if let Some(dir) = hooks_dir {
                match hooks::watch(app.handle().clone(), dir) {
                    Ok(watcher) => {
                        app.manage(watcher);
                    }
                    Err(e) => eprintln!("hook watcher: {e}"),
                }
            }
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
            commands::git_settings,
            commands::set_git_settings,
            commands::terminal_settings_get,
            commands::terminal_settings_put,
            commands::git_user_name,
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
            status::status_settings_get,
            status::status_settings_put,
            status::status_notify,
            status::status_badge,
            status::status_sound_set,
            status::status_sound,
            profiles::profiles_list,
            profiles::profile_put,
            profiles::profile_remove,
            profiles::profile_reset,
            profiles::profiles_defaults,
            profiles::shell_put,
            profiles::shell_remove,
            workspace::workspace_list,
            workspace::repo_add,
            workspace::repo_forget,
            workspace::repo_update,
            workspace::worktree_adopt,
            workspace::vault_list,
            workspace::vault_add,
            workspace::vault_forget,
            workspace::vault_create_docs,
            workspace::worktree_create,
            workspace::worktree_pin,
            workspace::worktree_remove,
            workspace::worktree_changes,
            workspace::worktree_stat,
            workspace::worktree_file_diff,
            review::worktree_review,
            review::worktree_review_file,
            review::worktree_stage,
            review::worktree_branches,
            review_notes::review_notes_get,
            review_notes::review_notes_put,
            workspace::worktree_commit,
            workspace::worktree_list_dir,
            ship::worktree_ship,
            ship::worktree_push,
            ship::worktree_pull,
            ship::worktree_sync,
            ship::worktree_fetch,
            ship::worktree_force_push,
            review::worktree_discard,
            review::worktree_stage_state,
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
            agent_sessions::agent_sessions,
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
pub(crate) mod test_dirs {
    use tempfile::TempDir;

    /// A temp dir under the long form of the temp path. Windows CI hands out
    /// 8.3 names like `RUNNER~1`, and git reports long paths, so fixtures that
    /// compare the two must start from the long form.
    pub(crate) fn long_temp_dir(prefix: &str) -> TempDir {
        let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
        TempDir::with_prefix_in(prefix, base).unwrap()
    }
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
