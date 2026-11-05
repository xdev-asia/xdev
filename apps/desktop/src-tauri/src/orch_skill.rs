//! The orchestration skill on this machine: status, install, and the update
//! at app start. The logic is in `xdev_orch::skills`; this only says which
//! folders it works on.

use tauri::{AppHandle, Manager};
use xdev_kit::Agent;
use xdev_orch::{InstallOpts, SkillEnv, SkillStatus, skills};

use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;

fn env(app: &AppHandle) -> Result<SkillEnv, CmdError> {
    let state = app.state::<AppState>();
    let ctx = Ctx::of(&state)?;
    Ok(SkillEnv {
        user_home: ctx.user_home().to_owned(),
        claude_homes: ctx
            .homes()
            .into_iter()
            .filter(|h| h.agent == Agent::Claude)
            .map(|h| h.path)
            .collect(),
        data_dir: ctx.data.clone(),
        now_ms: crate::workspace::clock().0,
    })
}

fn failed(e: xdev_orch::OrchError) -> CmdError {
    CmdError {
        code: e.code,
        detail: Some(e.message),
    }
}

pub fn status(app: &AppHandle) -> Result<SkillStatus, CmdError> {
    skills::status(&env(app)?).map_err(failed)
}

pub fn install(app: &AppHandle, force: bool) -> Result<SkillStatus, CmdError> {
    let env = env(app)?;
    skills::install(
        &env,
        InstallOpts {
            force,
            ..InstallOpts::default()
        },
        &skills::system_link,
    )
    .map_err(failed)?;
    skills::status(&env).map_err(failed)
}

/// App start: refresh unedited copies that are older than the bundled skill.
pub fn auto_update(app: AppHandle) {
    std::thread::spawn(move || {
        if let Ok(env) = env(&app) {
            let _ = skills::auto_update(&env, &skills::system_link);
        }
    });
}

/// Removes the copies and links xDev wrote; `force` also removes edited
/// copies, after a backup.
pub fn uninstall(app: &AppHandle, force: bool) -> Result<SkillStatus, CmdError> {
    let env = env(app)?;
    skills::uninstall(
        &env,
        InstallOpts {
            force,
            ..InstallOpts::default()
        },
    )
    .map_err(failed)?;
    skills::status(&env).map_err(failed)
}
