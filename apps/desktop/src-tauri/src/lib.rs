mod accounts;
mod agent_sessions;
mod app_menu;
mod atomic;
#[cfg(test)]
mod bindings;
mod cli_path;
mod cli_verbs;
mod clipboard;
mod commands;
mod endpoint;
mod files;
mod hooks;
mod issues;
mod keybindings;
mod keyboard;
mod kit;
mod layout;
mod links;
mod open_in;
mod orch_pump;
mod orch_skill;
mod orch_sweep;
mod orchestration;
mod ports;
mod power;
mod profiles;
mod prs;
mod pty;
mod ptyd;
mod quick_commands;
mod recipes;
mod reveal;
mod review;
mod review_notes;
mod session;
mod settings;
mod settings_store;
mod shell;
mod ship;
mod squads;
mod status;
mod tasks;
mod terminal_themes;
mod tray;
mod updater;
mod workspace;
mod xdev_id;

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
    // Moved in `setup`: a second instance exits during plugin init and must not run it.
    let index_dirs = data_dir.clone().zip(local_dir.clone());
    let dev_flag = std::env::var("XDEV_DEV_DEEP_LINK").ok();
    let sync_local = local_dir.clone();
    let ptyd_local = local_dir.clone();
    let endpoint_local = local_dir.clone();
    let hooks_dir = local_dir
        .as_ref()
        .map(|local| local.join(xdev_agent::HOOKS_DIR));
    let mut builder = tauri::Builder::default();
    // Must be the first plugin: a second instance exits during its init, before anything
    // else runs. With the deep-link feature the link already went to `on_open_url`.
    if xdev_id::single_instance_on(cfg!(debug_assertions), dev_flag.as_deref()) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            xdev_id::focus_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(updater::Pending::default())
        .manage(xdev_id::XdevIdHub::production())
        .manage(updater::Phase::default())
        .manage(shell::ShellState::default())
        // Terminals wait until the start below has picked where they run.
        .manage(pty::Ptys::pending())
        .manage(workspace::WorkspaceLock::default())
        .manage(workspace::Clones::default())
        .manage(review_notes::ReviewNotesLock::default())
        .manage(profiles::ProfilesLock::default())
        .manage(files::Searches::default())
        .manage(status::Shown::default())
        .manage(power::Awake::default())
        .manage(ports::Ports::default())
        .manage(cli_verbs::CliHub::default())
        .manage(orchestration::OrchHub::default())
        .manage(keybindings::LastSent::default())
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::Focused(true) = event
            {
                shell::window_focused(window.app_handle());
            }
        })
        .setup(move |app| {
            if let Some((data, local)) = &index_dirs {
                xdev_core::move_indexes(data, local);
            }
            updater::start(app.handle().clone());
            workspace::start_sweep(app.handle());
            // Every settings read and write goes through this store.
            if let Some(file) = commands::settings_path(app.handle()) {
                app.manage(settings_store::SettingsStore::new(file));
            }
            // After the settings store: the server setting is read first.
            xdev_id::start(app.handle());
            // The OS request follows the stored mode from the start. Off the main thread: a
            // helper is watched for an early exit, which takes a moment.
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let mode = settings_store::read(&app).agents.keep_awake;
                    power::apply_mode(&app, mode);
                });
            }
            workspace::start_migrations(app.handle());
            tray::sync(app.handle());
            app_menu::listen(app.handle());
            app_menu::install(app.handle());
            // Off the main thread: starting the service may take a moment.
            {
                let app = app.handle().clone();
                let local = ptyd_local.clone();
                std::thread::spawn(move || ptyd::start_host(&app, local.as_deref()));
            }
            // The `.off` marker follows the stored setting from the start,
            // not only once the setting is saved. Best effort.
            if let (Some(store), Some(local)) = (settings_store::store(app.handle()), &sync_local)
                && let Err(e) = status::sync_hooks_marker(&store, local)
            {
                eprintln!("hooks marker: {e}");
            }
            status::listen_clicks(app.handle());
            orchestration::start_pump(app.handle().clone());
            orch_sweep::start(app.handle().clone());
            orch_skill::auto_update(app.handle().clone());
            // The `xdev` CLI's way in; without it the app runs as before.
            if let Some(local) = &endpoint_local {
                let handler = std::sync::Arc::new(cli_verbs::AppVerbs {
                    app: app.handle().clone(),
                });
                let now = workspace::clock().0;
                match endpoint::start(
                    &xdev_ipc::app_dir(local),
                    endpoint::PREFIX,
                    xdev_core::version(),
                    now,
                    handler,
                ) {
                    Ok(running) => {
                        app.manage(running);
                    }
                    Err(e) => eprintln!("app endpoint: {e}"),
                }
            }
            // Without it an edit on disk shows only after a restart.
            let last = app.state::<keybindings::LastSent>().inner().clone();
            match keybindings::watch(app.handle().clone(), last) {
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(e) => eprintln!("keybindings watcher: {e}"),
            }
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
            clipboard::clipboard_image_save,
            keyboard::keyboard_input_source,
            updater::update_status,
            updater::update_notify,
            shell::shell_close_requested,
            shell::shell_quit,
            shell::shell_quit_cancelled,
            shell::shell_labels_set,
            shell::tray_attention,
            shell::help_open,
            shell::window_reload,
            shell::window_devtools_toggle,
            updater::update_check,
            updater::update_phase,
            commands::open_vault,
            commands::last_vault,
            commands::git_settings,
            commands::set_git_settings,
            commands::terminal_settings_get,
            commands::terminal_settings_put,
            commands::key_settings_get,
            commands::key_settings_put,
            commands::ui_settings_get,
            commands::ui_settings_put,
            layout::layout_load,
            layout::layout_save,
            open_in::open_in_settings,
            open_in::open_in_settings_put,
            open_in::open_in,
            commands::editor_settings_get,
            commands::editor_settings_put,
            commands::sidebar_prefs_get,
            commands::sidebar_prefs_put,
            commands::navigation_settings_get,
            commands::navigation_settings_put,
            commands::diff_settings_get,
            commands::diff_settings_put,
            commands::agents_settings_get,
            commands::agents_settings_put,
            commands::usage_settings_get,
            commands::usage_settings_put,
            orchestration::orchestration_settings_get,
            orchestration::orchestration_settings_put,
            orchestration::orchestration_skill_status,
            orchestration::orchestration_skill_install,
            orchestration::orchestration_worker_lifetime,
            orchestration::orchestration_worker_keep_open,
            orchestration::orchestration_worker_opened,
            orchestration::orchestration_read_answer,
            commands::shell_settings_get,
            commands::shell_settings_put,
            keybindings::keybindings_read,
            keybindings::keybindings_write,
            keybindings::keybindings_reveal,
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
            terminal_themes::terminal_themes_list,
            terminal_themes::terminal_theme_preview,
            terminal_themes::terminal_theme_import,
            terminal_themes::terminal_theme_remove,
            accounts::accounts_quota,
            accounts::account_add,
            accounts::account_login,
            accounts::account_remove,
            accounts::account_activate,
            accounts::account_carry_session,
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
            power::keep_awake_get,
            power::keep_awake_set,
            power::keep_awake_agents,
            ports::ports_scan,
            ports::ports_stop,
            ports::ports_open,
            pty::pty_spawn,
            pty::pty_approve,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            pty::pty_attach,
            pty::ptyd_status,
            pty::ptyd_sessions,
            pty::ptyd_end,
            pty::ptyd_end_all,
            pty::ptyd_restart,
            pty::ptyd_quit_choice,
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
            workspace::repo_clone,
            workspace::repo_clone_cancel,
            workspace::repo_clone_name,
            workspace::repo_create,
            workspace::worktree_name_preview,
            workspace::repo_update,
            ship::gh_logins,
            workspace::repo_hooks,
            workspace::repo_hook_trust,
            workspace::worktree_archive_run,
            workspace::worktree_adopt,
            workspace::vault_list,
            workspace::vault_add,
            workspace::vault_forget,
            workspace::vault_create_docs,
            workspace::worktree_create,
            workspace::worktree_pin,
            workspace::worktree_remove,
            workspace::worktree_archive,
            workspace::worktree_details,
            workspace::worktree_restore,
            workspace::kept_keep,
            workspace::branch_delete,
            workspace::workspace_sidebar,
            workspace::sidebar_order,
            workspace::group_put,
            workspace::group_remove,
            workspace::group_move,
            workspace::folder_add,
            workspace::folder_forget,
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
            files::file_read,
            files::file_write,
            files::file_create,
            files::file_rename,
            files::file_trash,
            files::file_reveal,
            files::files_list,
            files::files_search,
            files::files_search_cancel,
            ship::worktree_ship,
            ship::worktree_push,
            ship::worktree_pull,
            ship::worktree_sync,
            ship::worktree_fetch,
            ship::worktree_force_push,
            review::worktree_discard,
            review::worktree_stage_state,
            review::worktree_conflicts,
            review::worktree_conflict_continue,
            review::worktree_conflict_abort,
            ship::worktree_suggest_branch,
            workspace::worktree_rename_branch,
            ship::worktree_amend,
            ship::worktree_pr,
            ship::worktree_pr_create,
            ship::worktree_pr_checks,
            ship::worktree_pr_open,
            issues::issues_list,
            issues::issue_view,
            issues::issue_resolve,
            issues::issue_open,
            issues::issue_create,
            prs::prs_list,
            prs::pr_get,
            prs::pr_open,
            prs::pr_branch,
            prs::pr_branch_discard,
            prs::projects_list,
            prs::project_open,
            ship::worktree_draft_commit,
            ship::worktree_draft_pr,
            ship::worktree_check_log,
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
            kit::kit_usage_report,
            kit::kit_paths_exist,
            kit::kit_prompt_history,
            agent_sessions::agent_sessions,
            agent_sessions::session_search_status,
            agent_sessions::session_search_clear,
            quick_commands::quick_commands_list,
            quick_commands::quick_command_upsert,
            quick_commands::quick_command_delete,
            quick_commands::quick_commands_move,
            quick_commands::quick_command_used,
            quick_commands::quick_commands_recent,
            quick_commands::repo_file_commands,
            quick_commands::repo_file_commands_trust,
            cli_verbs::cli_tabs_report,
            cli_verbs::cli_approve,
            xdev_id::xdev_id_state,
            xdev_id::xdev_id_sign_in,
            xdev_id::xdev_id_paste,
            xdev_id::xdev_id_cancel,
            xdev_id::xdev_id_sign_out,
            xdev_id::xdev_id_refresh,
            xdev_id::xdev_id_reopen,
            xdev_id::xdev_id_manage,
            xdev_id::xdev_id_server,
            xdev_id::xdev_id_server_set,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start xDev")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                shell::exit_requested(app, *code, api);
            }
            if let tauri::RunEvent::Exit = event {
                tray::remove(app);
                let mode = shell::quit_mode(app);
                let on_quit = shell::on_quit_for(mode, settings_store::read(app).terminal.on_quit);
                app.state::<pty::Ptys>().quit(on_quit);
                app.state::<power::Awake>().release();
                if let Some(running) = app.try_state::<endpoint::Running>() {
                    running.stop();
                }
                // Every `terminal wait` ends with `app_stopped`.
                app.state::<cli_verbs::CliHub>().board.stop();
                updater::install_pending(app);
                if mode == Some(shell::QuitMode::Restart) {
                    // Never returns: the process starts again from the installed build.
                    tauri::process::restart(&app.env());
                }
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

    #[test]
    fn deep_link_scheme_is_xdev() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["plugins"]["deep-link"]["desktop"]["schemes"],
            serde_json::json!(["xdev"])
        );
    }

    #[test]
    fn csp_allows_data_images_only() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let img = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("img-src"))
            .unwrap();
        assert_eq!(img, "img-src 'self' data:");
        assert!(!img.contains("https:") && !img.contains('*'));
    }

    #[test]
    fn deb_template_passes_the_url() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["linux"]["deb"]["desktopTemplate"],
            "linux/xdev.desktop.hbs"
        );
        let template = include_str!("../linux/xdev.desktop.hbs");
        assert!(template.lines().any(|l| l == "Exec={{exec}} %u"));
        assert!(template.lines().any(|l| l == "MimeType={{mime_type}}"));
    }
}
