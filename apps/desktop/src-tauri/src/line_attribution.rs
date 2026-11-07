//! Who wrote each changed line of a review file, computed on demand from
//! what attribution already keeps: the diff's base text, the kept agent
//! versions and hidden outside versions of the file (merged oldest first)
//! and the file on disk.
//!
//! Each version is line-diffed against the one before it; lines it inserts
//! or replaces go to that version's author. Outside versions and the final
//! step to the text on disk give their changes to "outside" (the person, or
//! any tool that is not an agent). Lines equal to the base carry nothing.
//!
//! Known gaps, where a person's edit is folded into the next agent version:
//! (a) edits made while exactly one agent tab works (that tab gets them),
//! (b) edits made before the file's first agent version, (c) edits made while
//! two or more agent tabs work and no hook names the writer, (d) outside
//! versions dropped by the cap of five per file.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use similar::{Algorithm, DiffOp, capture_diff_slices_deadline};
use tauri::State;
use xdev_git::Repo;

use crate::accounts::data_dir;
use crate::attribution::{FileVersion, Snapshots, folder_of};
use crate::commands::{AppState, CmdError};

/// The longest one line diff may take; a hit gives a valid, less minimal diff.
const DIFF_DEADLINE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LineAuthorKind {
    /// An agent tab whose kept version wrote the line.
    Agent,
    /// Changed by the person or a tool that is not an agent.
    Outside,
}

/// One author of some lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineAuthor {
    pub kind: LineAuthorKind,
    pub tab_id: Option<String>,
    pub agent: Option<String>,
    /// The version's time in Unix milliseconds; `None` for outside.
    pub at: Option<i64>,
}

/// 1-based, inclusive lines of the current text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineRun {
    pub from: u32,
    pub to: u32,
    /// Index into `authors`.
    pub author: u32,
}

/// `lines` is the line count of the text the runs are for.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineAttribution {
    pub lines: u32,
    pub authors: Vec<LineAuthor>,
    pub runs: Vec<LineRun>,
}

/// Lines as CodeMirror counts them: split on `\r\n`, `\n` or `\r`, and a
/// trailing terminator yields a final empty line.
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&text[start..i]);
                i += if bytes.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

fn diff(old: &[&str], new: &[&str]) -> Vec<DiffOp> {
    let deadline = Instant::now() + DIFF_DEADLINE;
    capture_diff_slices_deadline(Algorithm::Myers, old, new, Some(deadline))
}

/// The owners of `new`'s lines: equal lines keep theirs from `old`, inserted
/// or replaced lines get `fill`.
fn carry(old: &[&str], owners: &[Option<u32>], new: &[&str], fill: u32) -> Vec<Option<u32>> {
    let mut out = vec![Some(fill); new.len()];
    for op in diff(old, new) {
        if let DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = op
        {
            out[new_index..new_index + len].copy_from_slice(&owners[old_index..old_index + len]);
        }
    }
    out
}

/// The author of each line of `current`, or `None` for a line equal to
/// `base`. `versions` are (text, author) oldest first; `outside` is the
/// author of what changed after the last version.
pub fn line_owners(
    base: &str,
    versions: &[(&str, u32)],
    current: &str,
    outside: u32,
) -> Vec<Option<u32>> {
    let base_lines = split_lines(base);
    let mut lines = base_lines.clone();
    let mut owners = vec![None; lines.len()];
    for (text, author) in versions {
        let next = split_lines(text);
        owners = carry(&lines, &owners, &next, *author);
        lines = next;
    }
    let now = split_lines(current);
    owners = carry(&lines, &owners, &now, outside);
    for op in diff(&base_lines, &now) {
        if let DiffOp::Equal { new_index, len, .. } = op {
            owners[new_index..new_index + len].fill(None);
        }
    }
    owners
}

/// Runs of equal, non-`None` owners as 1-based inclusive line ranges.
pub fn to_runs(owners: &[Option<u32>]) -> Vec<LineRun> {
    let mut runs: Vec<LineRun> = Vec::new();
    for (i, owner) in owners.iter().enumerate() {
        let Some(author) = *owner else { continue };
        let line = i as u32 + 1;
        match runs.last_mut() {
            Some(r) if r.author == author && r.to + 1 == line => r.to = line,
            _ => runs.push(LineRun {
                from: line,
                to: line,
                author,
            }),
        }
    }
    runs
}

/// The per-line authors of `current` against `base`, from kept agent
/// versions and outside versions in any order. Both are replayed by time; on
/// equal times the outside version goes first. Only authors that own a line
/// are listed, outside last and at most once.
pub fn line_attribution(
    base: &str,
    versions: &[(FileVersion, String)],
    outside_versions: &[(FileVersion, String)],
    current: Option<&str>,
) -> LineAttribution {
    let Some(current) = current else {
        return LineAttribution::default();
    };
    let mut ordered: Vec<&(FileVersion, String)> = versions.iter().collect();
    ordered.sort_by_key(|(v, _)| v.at);
    let outside = ordered.len() as u32;
    // (time, is agent, text, author); the stable sort keeps agent order.
    let mut steps: Vec<(i64, bool, &str, u32)> = ordered
        .iter()
        .enumerate()
        .map(|(i, (v, text))| (v.at, true, text.as_str(), i as u32))
        .chain(
            outside_versions
                .iter()
                .map(|(v, text)| (v.at, false, text.as_str(), outside)),
        )
        .collect();
    steps.sort_by_key(|(at, agent, _, _)| (*at, *agent));
    let replay: Vec<(&str, u32)> = steps.iter().map(|(_, _, t, a)| (*t, *a)).collect();
    let owners = line_owners(base, &replay, current, outside);

    // Version index → author index, in version order, outside last.
    let mut used = vec![false; ordered.len() + 1];
    for o in owners.iter().flatten() {
        used[*o as usize] = true;
    }
    let mut map = vec![0u32; used.len()];
    let mut authors = Vec::new();
    for (i, _) in used.iter().enumerate().filter(|(_, u)| **u) {
        map[i] = authors.len() as u32;
        authors.push(match ordered.get(i) {
            Some((v, _)) => LineAuthor {
                kind: LineAuthorKind::Agent,
                tab_id: v.tab_id.clone(),
                agent: v.agent.clone(),
                at: Some(v.at),
            },
            None => LineAuthor {
                kind: LineAuthorKind::Outside,
                tab_id: None,
                agent: None,
                at: None,
            },
        });
    }
    let owners: Vec<Option<u32>> = owners.iter().map(|o| o.map(|i| map[i as usize])).collect();
    LineAttribution {
        lines: owners.len() as u32,
        authors,
        runs: to_runs(&owners),
    }
}

fn lines_of(
    data: &Path,
    worktree: &str,
    path: &str,
    base: &str,
) -> Result<LineAttribution, CmdError> {
    let file = crate::review::review_file(data, Path::new(worktree), base, path)?;
    if file.skip.is_some() {
        return Ok(LineAttribution::default());
    }
    let snaps = Snapshots::new(folder_of(data, worktree).join("snaps"));
    let versions: Vec<(FileVersion, String)> = snaps
        .versions(path)
        .into_iter()
        .filter_map(|v| snaps.read(path, &v.id).map(|text| (v, text)))
        .collect();
    let outside: Vec<(FileVersion, String)> = snaps
        .outside(path)
        .into_iter()
        .filter_map(|v| snaps.read_outside(path, &v.id).map(|text| (v, text)))
        .collect();
    Ok(line_attribution(
        file.old.as_deref().unwrap_or(""),
        &versions,
        &outside,
        file.new.as_deref(),
    ))
}

/// Who wrote each changed line of `path`, against review base id `base`.
#[tauri::command(async)]
pub fn attribution_lines(
    state: State<'_, AppState>,
    worktree: String,
    path: String,
    base: String,
) -> Result<LineAttribution, CmdError> {
    crate::remote_ssh::local_only(Path::new(&worktree), "attribution_lines")?;
    lines_of(data_dir(&state)?, &worktree, &path, &base)
}

/// The authors of `path` against `head`, the worktree's `HEAD` id (`None`
/// before the first commit). Empty with no commit, and for a file no agent
/// wrote: the editor's gutter is about agent lines, and the change gutter
/// already shows the person's.
fn head_lines(
    data: &Path,
    worktree: &str,
    path: &str,
    head: Option<&str>,
) -> Result<LineAttribution, CmdError> {
    let Some(head) = head else {
        return Ok(LineAttribution::default());
    };
    let snaps = Snapshots::new(folder_of(data, worktree).join("snaps"));
    if snaps.versions(path).is_empty() {
        return Ok(LineAttribution::default());
    }
    lines_of(data, worktree, path, head)
}

/// Who wrote each changed line of `path`, against the worktree's `HEAD`. For
/// the file editor.
#[tauri::command(async)]
pub fn attribution_lines_head(
    state: State<'_, AppState>,
    worktree: String,
    path: String,
) -> Result<LineAttribution, CmdError> {
    crate::remote_ssh::local_only(Path::new(&worktree), "attribution_lines_head")?;
    let data = data_dir(&state)?;
    crate::review::known(data, Path::new(&worktree))?;
    let head = Repo::discover(Path::new(&worktree))?.head_id()?;
    head_lines(data, &worktree, &path, head.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: u32 = 0;
    const B: u32 = 1;
    const OUT: u32 = 9;

    fn version(at: i64, tab: &str, agent: &str) -> FileVersion {
        FileVersion {
            id: format!("v{at}"),
            at,
            size: 0,
            tab_id: Some(tab.into()),
            agent: Some(agent.into()),
        }
    }

    #[test]
    fn split_lines_matches_codemirror() {
        assert_eq!(split_lines("a\r\nb\rc\n"), ["a", "b", "c", ""]);
        assert_eq!(split_lines(""), [""]);
        assert_eq!(split_lines("a"), ["a"]);
        assert_eq!(split_lines("\r\r\n"), ["", "", ""]);
    }

    #[test]
    fn no_versions_and_no_change_owns_nothing() {
        assert_eq!(line_owners("a\nb", &[], "a\nb", OUT), [None, None]);
    }

    #[test]
    fn an_agent_line_goes_to_the_agent() {
        let v = [("a\nX\nb", A)];
        assert_eq!(
            line_owners("a\nb", &v, "a\nX\nb", OUT),
            [None, Some(A), None]
        );
    }

    #[test]
    fn a_person_edit_after_the_agent_wins() {
        let v = [("a\nX\nb", A)];
        assert_eq!(
            line_owners("a\nb", &v, "a\nY\nb", OUT),
            [None, Some(OUT), None]
        );
    }

    #[test]
    fn two_agents_and_a_rewrite() {
        let v = [("a\nX", A), ("a\nX\nZ", B)];
        assert_eq!(
            line_owners("a", &v, "a\nX\nZ", OUT),
            [None, Some(A), Some(B)]
        );
        let v = [("a\nX", A), ("a\nX\nZ", B), ("a\nX\nZ2", A)];
        assert_eq!(
            line_owners("a", &v, "a\nX\nZ2", OUT),
            [None, Some(A), Some(A)]
        );
    }

    #[test]
    fn a_line_added_then_removed_is_gone() {
        let v = [("a\nX\nb", A), ("a\nb\nY", B)];
        let owners = line_owners("a\nb", &v, "a\nb\nY", OUT);
        assert_eq!(owners, [None, None, Some(B)]);
        assert_eq!(owners.len(), split_lines("a\nb\nY").len());
    }

    #[test]
    fn lines_equal_to_base_are_masked() {
        // An old version from before the base lacks `b`; the next restores it.
        let v = [("a", A), ("a\nb\nX", B)];
        assert_eq!(
            line_owners("a\nb", &v, "a\nb\nX", OUT),
            [None, None, Some(B)]
        );
    }

    #[test]
    fn without_an_outside_snapshot_a_person_edit_goes_to_the_next_agent() {
        // `H` stands for the person's edit made before A's snapshot.
        let v = [("a\nX\nH", A)];
        assert_eq!(
            line_owners("a", &v, "a\nX\nH", OUT),
            [None, Some(A), Some(A)]
        );
    }

    fn outside_version(at: i64) -> FileVersion {
        FileVersion {
            id: format!("o{at}"),
            at,
            size: 0,
            tab_id: None,
            agent: None,
        }
    }

    /// Each line's owner: the tab id, "out" for outside, or None.
    fn owners_of(attr: &LineAttribution) -> Vec<Option<String>> {
        let mut out = vec![None; attr.lines as usize];
        for r in &attr.runs {
            let a = &attr.authors[r.author as usize];
            let name = match a.kind {
                LineAuthorKind::Agent => a.tab_id.clone().unwrap(),
                LineAuthorKind::Outside => "out".to_owned(),
            };
            for line in r.from..=r.to {
                out[line as usize - 1] = Some(name.clone());
            }
        }
        out
    }

    fn names(list: &[Option<&str>]) -> Vec<Option<String>> {
        list.iter().map(|n| n.map(str::to_owned)).collect()
    }

    #[test]
    fn an_outside_snapshot_between_agents_goes_to_the_person() {
        let versions = vec![
            (version(10, "A", "claude"), "a\nX".to_owned()),
            (version(30, "B", "codex"), "a\nX\nH\nZ".to_owned()),
        ];
        let outside = vec![(outside_version(20), "a\nX\nH".to_owned())];
        let attr = line_attribution("a", &versions, &outside, Some("a\nX\nH\nZ"));
        assert_eq!(
            owners_of(&attr),
            names(&[None, Some("A"), Some("out"), Some("B")])
        );
    }

    #[test]
    fn an_agent_rewrite_after_an_outside_snapshot_goes_to_the_agent() {
        let versions = vec![(version(20, "A", "claude"), "a\nH2".to_owned())];
        let outside = vec![(outside_version(10), "a\nH".to_owned())];
        let attr = line_attribution("a", &versions, &outside, Some("a\nH2"));
        assert_eq!(owners_of(&attr), names(&[None, Some("A")]));
    }

    #[test]
    fn on_equal_times_the_outside_snapshot_goes_first() {
        // The agent adds to the outside text at the same time: its line is the
        // agent's, the rest stays outside. Agent first would give the reverse.
        // (Equal content never reaches the replay: the store drops the outside
        // entry when an agent records the same content.)
        let outside = vec![(outside_version(20), "a\nX".to_owned())];
        let versions = vec![(version(20, "A", "claude"), "a\nX\nY".to_owned())];
        let attr = line_attribution("a", &versions, &outside, Some("a\nX\nY"));
        assert_eq!(owners_of(&attr), names(&[None, Some("out"), Some("A")]));
    }

    #[test]
    fn several_outside_snapshots_are_one_outside_author_listed_last() {
        let versions = vec![
            (version(10, "t1", "claude"), "a\nX".to_owned()),
            (version(30, "t2", "codex"), "a\nX\nH\nY".to_owned()),
        ];
        let outside = vec![
            (outside_version(40), "a\nX\nH\nY\nK".to_owned()),
            (outside_version(20), "a\nX\nH".to_owned()),
        ];
        let attr = line_attribution("a", &versions, &outside, Some("a\nX\nH\nY\nK\nL"));
        let kinds: Vec<_> = attr.authors.iter().map(|a| a.kind).collect();
        assert_eq!(
            kinds,
            [
                LineAuthorKind::Agent,
                LineAuthorKind::Agent,
                LineAuthorKind::Outside
            ]
        );
        assert_eq!(attr.authors[0].tab_id.as_deref(), Some("t1"));
        assert_eq!(attr.authors[1].tab_id.as_deref(), Some("t2"));
        assert_eq!(attr.authors[2].at, None);
        assert_eq!(
            owners_of(&attr),
            names(&[
                None,
                Some("t1"),
                Some("out"),
                Some("t2"),
                Some("out"),
                Some("out")
            ])
        );
    }

    #[test]
    fn crlf_current_keeps_owners_of_an_lf_version() {
        let v = [("a\nX\nb\n", A)];
        assert_eq!(
            line_owners("a\r\nb\r\n", &v, "a\r\nX\r\nb\r\n", OUT),
            [None, Some(A), None, None]
        );
    }

    #[test]
    fn runs_are_one_based_and_inclusive() {
        let runs = to_runs(&[None, Some(A), Some(A), Some(OUT), None, Some(A)]);
        let want = [(2, 3, A), (4, 4, OUT), (6, 6, A)].map(|(from, to, author)| LineRun {
            from,
            to,
            author,
        });
        assert_eq!(runs, want);
    }

    #[test]
    fn authors_list_only_owners_and_outside_last() {
        let versions = vec![
            (version(30, "t2", "codex"), "a\nX\nb\nY".to_owned()),
            (version(10, "t1", "claude"), "a\nQ\nb".to_owned()),
            (version(20, "t1", "claude"), "a\nX\nb".to_owned()),
        ];
        let attr = line_attribution("a\nb", &versions, &[], Some("a\nX\nb\nY\nZ"));
        assert_eq!(attr.lines, 5);
        assert_eq!(
            attr.authors,
            [
                LineAuthor {
                    kind: LineAuthorKind::Agent,
                    tab_id: Some("t1".into()),
                    agent: Some("claude".into()),
                    at: Some(20),
                },
                LineAuthor {
                    kind: LineAuthorKind::Agent,
                    tab_id: Some("t2".into()),
                    agent: Some("codex".into()),
                    at: Some(30),
                },
                LineAuthor {
                    kind: LineAuthorKind::Outside,
                    tab_id: None,
                    agent: None,
                    at: None,
                },
            ]
        );
        assert_eq!(
            attr.runs,
            [
                LineRun {
                    from: 2,
                    to: 2,
                    author: 0
                },
                LineRun {
                    from: 4,
                    to: 4,
                    author: 1
                },
                LineRun {
                    from: 5,
                    to: 5,
                    author: 2
                },
            ]
        );
    }

    #[test]
    fn no_outside_author_when_unused() {
        let versions = vec![(version(1, "t1", "claude"), "a\nX".to_owned())];
        let attr = line_attribution("a", &versions, &[], Some("a\nX"));
        assert_eq!(attr.authors.len(), 1);
        assert_eq!(attr.authors[0].kind, LineAuthorKind::Agent);
        assert_eq!(attr.lines, split_lines("a\nX").len() as u32);
    }

    #[test]
    fn no_current_text_is_empty() {
        let versions = vec![(version(1, "t1", "claude"), "a\nX".to_owned())];
        assert_eq!(
            line_attribution("a", &versions, &[], None),
            LineAttribution {
                lines: 0,
                authors: vec![],
                runs: vec![]
            }
        );
    }

    #[test]
    fn twenty_versions_of_a_large_file_finish() {
        let base: String = (0..5_000).map(|i| format!("line {i}\n")).collect();
        let versions: Vec<(FileVersion, String)> = (0..20)
            .map(|v| {
                let text: String = (0..5_000)
                    .map(|i| {
                        if i % 50 == v {
                            format!("edit {v} {i}\n")
                        } else {
                            format!("line {i}\n")
                        }
                    })
                    .collect();
                (version(v as i64, "t1", "claude"), text)
            })
            .collect();
        let current = versions[19].1.clone();
        let attr = line_attribution(&base, &versions, &[], Some(&current));
        assert_eq!(attr.lines, 5_001);
        assert!(!attr.runs.is_empty());
    }

    #[test]
    fn an_unknown_worktree_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let err = lines_of(
            data.path(),
            wt.path().to_str().unwrap(),
            "a.txt",
            "0123456789abcdef0123456789abcdef01234567",
        )
        .unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
    }

    fn agent_version(data: &Path, wt: &str) {
        Snapshots::new(folder_of(data, wt).join("snaps"))
            .record("a.txt", b"x", 1, Some("t1".into()), Some("claude".into()))
            .unwrap()
            .unwrap();
    }

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn head_lines_of_an_unknown_worktree_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let wt = wt.path().to_str().unwrap();
        agent_version(data.path(), wt);
        let err = head_lines(data.path(), wt, "a.txt", Some(HEAD)).unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
    }

    #[test]
    fn head_lines_without_a_commit_are_empty() {
        let data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let wt = wt.path().to_str().unwrap();
        agent_version(data.path(), wt);
        let got = head_lines(data.path(), wt, "a.txt", None).unwrap();
        assert_eq!(got, LineAttribution::default());
    }

    #[test]
    fn head_lines_of_a_file_no_agent_wrote_are_empty() {
        let data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let wt = wt.path().to_str().unwrap();
        let got = head_lines(data.path(), wt, "a.txt", Some(HEAD)).unwrap();
        assert_eq!(got, LineAttribution::default());
    }
}
