//! Splits a goal into task drafts with the default agent. Nothing is
//! written: the app shows the drafts and saves the kept ones with
//! `board_create_many`.

use std::path::PathBuf;

use tauri::State;
use xdev_board::TaskDraft;
use xdev_board::decompose::{DecomposeError, parse_answer, prompt};
use xdev_git::Repo;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::settings::Recipe;
use crate::workspace::{bad_arg, known_checkout};

/// Longest goal accepted, in characters.
const MAX_GOAL: usize = 4000;

/// The goal, trimmed, when it is fit to send.
fn check_goal(goal: &str) -> Result<&str, CmdError> {
    let goal = goal.trim();
    if goal.is_empty() || goal.chars().count() > MAX_GOAL {
        return Err(bad_arg("goal"));
    }
    Ok(goal)
}

fn map_err(e: DecomposeError) -> CmdError {
    CmdError {
        code: match e {
            DecomposeError::Empty => "board_decompose_empty",
            DecomposeError::Bad => "board_decompose_bad",
        },
        detail: None,
    }
}

#[tauri::command(async)]
pub fn board_decompose(
    state: State<'_, AppState>,
    repo: PathBuf,
    goal: String,
) -> Result<Vec<TaskDraft>, CmdError> {
    let goal = check_goal(&goal)?;
    let data = data_dir(&state)?;
    known_checkout(data, &repo)?;
    let recipe = Recipe::default();
    let runner = crate::ship::draft_runner(data, &repo, &recipe)?;
    let git = Repo::discover(&repo)?;
    let answer = crate::ship::ask(runner.as_ref(), &git, prompt(goal), &recipe.args);
    match answer {
        Ok(a) => parse_answer(&a).map_err(map_err),
        // An agent that answered nothing gave no tasks.
        Err(e) if e.detail.as_deref() == Some("empty") => Err(map_err(DecomposeError::Empty)),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_goal_is_refused() {
        assert_eq!(check_goal("  \n ").unwrap_err().code, "bad_arg");
        assert_eq!(check_goal("").unwrap_err().code, "bad_arg");
    }

    #[test]
    fn a_long_goal_is_refused() {
        assert!(check_goal(&"a".repeat(4000)).is_ok());
        assert_eq!(check_goal(&"a".repeat(4001)).unwrap_err().code, "bad_arg");
    }

    #[test]
    fn answers_map_to_codes() {
        assert_eq!(map_err(DecomposeError::Empty).code, "board_decompose_empty");
        assert_eq!(map_err(DecomposeError::Bad).code, "board_decompose_bad");
    }
}
