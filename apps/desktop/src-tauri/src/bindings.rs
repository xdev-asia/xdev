//! Writes `packages/bindings/src`: the TypeScript for every value a command
//! takes or returns, or an event carries. A test, so `cargo test` keeps the
//! committed files current and CI can fail on a diff.

use std::fs;
use std::path::Path;

use ts_rs::{Config, TS};

use crate::accounts::{Account, Accounts, LoginStart, Models};
use crate::agent_sessions::{SessionQuery, SessionRow};
use crate::cli_verbs::{CliAsk, CliOpenTab, TabReport};
use crate::commands::{Changed, CmdError, Expected, VaultSetup, VcsState};
use crate::hooks::PtyHook;
use crate::keybindings::{KeybindingsChanged, KeybindingsText};
use crate::kit::{KitText, PromptEntry};
use crate::open_in::OpenTarget;
use crate::profiles::ProfilesView;
use crate::pty::{PtyAttached, PtyExit, PtyInfo, PtydStatus};
use crate::quick_commands::{FileCommands, QuickCommand};
use crate::review::{ReviewBranch, ReviewData, StageState};
use crate::review_notes::ReviewNote;
use crate::settings::{
    AgentsSettings, DiffSettings, EditorSettings, GitSettings, KeySettings, NavigationSettings,
    OpenInSettings, RestoreMode, SettingsChanged, SidebarPrefs, StatusSettings, TerminalSettings,
    Theme, UiSettings, UsageSettings,
};
use crate::ship::ShipView;
use crate::squads::{SquadItem, SquadView};
use crate::tasks::{FileDiff, TasksContext};
use crate::updater::UpdateInfo;
use crate::workspace::{
    CloneProgress, CreateRequest, WorktreeChange, WorktreeCreated, WorktreeFileDiff,
};

/// Each type's dependencies are written with it, so only the roots are here.
fn export_roots(cfg: &Config) -> Result<(), ts_rs::ExportError> {
    CmdError::export_all(cfg)?;
    Changed::export_all(cfg)?;
    VaultSetup::export_all(cfg)?;
    VcsState::export_all(cfg)?;
    GitSettings::export_all(cfg)?;
    Expected::export_all(cfg)?;
    xdev_core::DocEntry::export_all(cfg)?;
    xdev_core::SearchHit::export_all(cfg)?;
    xdev_core::Change::export_all(cfg)?;
    xdev_core::Seen::export_all(cfg)?;
    xdev_core::Commit::export_all(cfg)?;
    xdev_core::DocLink::export_all(cfg)?;
    xdev_core::Freshness::export_all(cfg)?;
    xdev_core::StaleDoc::export_all(cfg)?;
    xdev_core::ExportPlan::export_all(cfg)?;
    Account::export_all(cfg)?;
    Accounts::export_all(cfg)?;
    LoginStart::export_all(cfg)?;
    xdev_ai::Quota::export_all(cfg)?;
    TasksContext::export_all(cfg)?;
    FileDiff::export_all(cfg)?;
    xdev_agent::Task::export_all(cfg)?;
    SquadItem::export_all(cfg)?;
    SquadView::export_all(cfg)?;
    xdev_agent::Seat::export_all(cfg)?;
    xdev_agent::Routing::export_all(cfg)?;
    Models::export_all(cfg)?;
    UpdateInfo::export_all(cfg)?;
    ProfilesView::export_all(cfg)?;
    xdev_agent::CustomShell::export_all(cfg)?;
    PtyInfo::export_all(cfg)?;
    PtyExit::export_all(cfg)?;
    PtyAttached::export_all(cfg)?;
    PtydStatus::export_all(cfg)?;
    xdev_pty::proto::SessionInfo::export_all(cfg)?;
    StatusSettings::export_all(cfg)?;
    TerminalSettings::export_all(cfg)?;
    SettingsChanged::export_all(cfg)?;
    KeySettings::export_all(cfg)?;
    UiSettings::export_all(cfg)?;
    RestoreMode::export_all(cfg)?;
    Theme::export_all(cfg)?;
    OpenInSettings::export_all(cfg)?;
    OpenTarget::export_all(cfg)?;
    CloneProgress::export_all(cfg)?;
    EditorSettings::export_all(cfg)?;
    SidebarPrefs::export_all(cfg)?;
    NavigationSettings::export_all(cfg)?;
    DiffSettings::export_all(cfg)?;
    AgentsSettings::export_all(cfg)?;
    UsageSettings::export_all(cfg)?;
    KeybindingsText::export_all(cfg)?;
    KeybindingsChanged::export_all(cfg)?;
    PtyHook::export_all(cfg)?;
    xdev_workspace::RepoView::export_all(cfg)?;
    xdev_workspace::RepoHooks::export_all(cfg)?;
    xdev_workspace::HookKind::export_all(cfg)?;
    xdev_workspace::HookRun::export_all(cfg)?;
    xdev_workspace::WorktreeView::export_all(cfg)?;
    xdev_workspace::WorktreeStat::export_all(cfg)?;
    xdev_workspace::DetailsPatch::export_all(cfg)?;
    xdev_workspace::Removed::export_all(cfg)?;
    xdev_workspace::SidebarItem::export_all(cfg)?;
    WorktreeChange::export_all(cfg)?;
    WorktreeCreated::export_all(cfg)?;
    xdev_workspace::Linked::export_all(cfg)?;
    xdev_workspace::CreateProject::export_all(cfg)?;
    xdev_workspace::Created::export_all(cfg)?;
    xdev_workspace::NamePreview::export_all(cfg)?;
    xdev_workspace::DefaultTab::export_all(cfg)?;
    WorktreeFileDiff::export_all(cfg)?;
    ReviewData::export_all(cfg)?;
    ReviewBranch::export_all(cfg)?;
    StageState::export_all(cfg)?;
    xdev_git::ConflictState::export_all(cfg)?;
    xdev_git::ConflictOp::export_all(cfg)?;
    ReviewNote::export_all(cfg)?;
    xdev_workspace::DirListing::export_all(cfg)?;
    xdev_workspace::FileText::export_all(cfg)?;
    xdev_workspace::WriteOutcome::export_all(cfg)?;
    xdev_workspace::FileList::export_all(cfg)?;
    xdev_workspace::SearchQuery::export_all(cfg)?;
    xdev_workspace::SearchEvent::export_all(cfg)?;
    ShipView::export_all(cfg)?;
    xdev_git::Upstream::export_all(cfg)?;
    xdev_git::BaseRange::export_all(cfg)?;
    xdev_git::PrView::export_all(cfg)?;
    xdev_git::PrState::export_all(cfg)?;
    xdev_git::Check::export_all(cfg)?;
    xdev_git::CheckBucket::export_all(cfg)?;
    xdev_git::PrDraft::export_all(cfg)?;
    xdev_git::Issue::export_all(cfg)?;
    xdev_git::IssueState::export_all(cfg)?;
    xdev_git::IssueComment::export_all(cfg)?;
    xdev_git::IssueDetail::export_all(cfg)?;
    xdev_git::IssueQuery::export_all(cfg)?;
    xdev_git::GhAccount::export_all(cfg)?;
    xdev_git::GhLogin::export_all(cfg)?;
    xdev_git::PrSummary::export_all(cfg)?;
    crate::prs::PrBranch::export_all(cfg)?;
    xdev_git::PrFilter::export_all(cfg)?;
    xdev_git::PrQuery::export_all(cfg)?;
    xdev_git::IssueDraft::export_all(cfg)?;
    xdev_git::ProjectSummary::export_all(cfg)?;
    CreateRequest::export_all(cfg)?;
    xdev_workspace::RepoIcon::export_all(cfg)?;
    KitText::export_all(cfg)?;
    PromptEntry::export_all(cfg)?;
    xdev_kit::Home::export_all(cfg)?;
    xdev_kit::Skill::export_all(cfg)?;
    xdev_kit::MemorySet::export_all(cfg)?;
    xdev_kit::UsageSummary::export_all(cfg)?;
    xdev_kit::UsageReport::export_all(cfg)?;
    crate::kit::UsageReportArgs::export_all(cfg)?;
    SessionQuery::export_all(cfg)?;
    SessionRow::export_all(cfg)?;
    xdev_workspace::VaultView::export_all(cfg)?;
    xdev_workspace::VaultKind::export_all(cfg)?;
    QuickCommand::export_all(cfg)?;
    FileCommands::export_all(cfg)?;
    TabReport::export_all(cfg)?;
    CliOpenTab::export_all(cfg)?;
    CliAsk::export_all(cfg)?;
    Ok(())
}

#[test]
fn export_bindings() {
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/bindings/src");
    // serde_json writes 64-bit integers as plain JSON numbers, never BigInt.
    let cfg = Config::new().with_large_int("number").with_out_dir(&out);

    // Cleared first so a type removed from Rust disappears from the package.
    fs::create_dir_all(&out).unwrap();
    for entry in fs::read_dir(&out).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "ts") {
            fs::remove_file(path).unwrap();
        }
    }
    export_roots(&cfg).unwrap();

    let mut names: Vec<String> = fs::read_dir(&out)
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().ok()?;
            Some(name.strip_suffix(".ts")?.to_owned())
        })
        .collect();
    names.sort();
    let index: String = names
        .iter()
        .map(|n| format!("export type {{ {n} }} from \"./{n}\";\n"))
        .collect();
    fs::write(
        out.join("index.ts"),
        format!(
            "// Generated by `cargo test -p xdev-desktop export_bindings`. Do not edit.\n{index}"
        ),
    )
    .unwrap();
}
