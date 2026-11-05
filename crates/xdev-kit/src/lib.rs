//! Agent kit: reads the agent homes, their skills and memory files, and the
//! CLI session logs on this machine. Writes only through `write`.

mod drafts;
mod homes;
mod logs;
mod memory;
mod pricing;
mod records;
mod sessions;
mod skills;
mod templates;
mod transcripts;
mod usage;
mod usage_report;
mod write;

pub use drafts::{DRAFT_MAX_BYTES, DRAFTS_MAX, Drafts};
pub use homes::{Agent, Home, HomeSource, KitError, approx_tokens, homes};
pub use logs::FileMark;
pub use memory::{
    IssueKind, MemoryFile, MemoryIssue, MemoryKind, MemorySet, project_slug, scan_memory,
};
pub use pricing::{PRICES_AS_OF, Rates, cost_nanos, rates_for};
pub use sessions::{AgentSession, SessionIndex};
pub use skills::{
    AGENT_SKILL_ROOTS, Skill, SkillScope, mark_duplicates, scan_agent_roots, scan_skill_root,
    scan_skills,
};
pub use templates::{PromptTemplate, TEMPLATES_MAX, TemplateMode, Templates};
pub use transcripts::{
    CONVERSATION_PAGE, CONVERSATION_PAGE_MAX, ConversationItem, ConversationKind, ConversationPage,
    MarkerKind, TOOL_OUTPUT_MAX, ToolStatus, ToolStep, conversation, conversation_of_text,
};
pub use transcripts::{
    ContextUsage, TailTurn, TextRole, TranscriptEvent, TranscriptText, claude_window,
    context_usage, scan_transcripts, tail_turns,
};
pub use usage::{
    RefreshStats, SessionUsage, Tokens, UsageIndex, UsageQuery, UsageSummary, summarize,
};
pub use usage_report::{Cost, ReportQuery, UsageReport, report, under_any};
pub use write::{
    Roots, copy_file, copy_skill_dir, new_skill, read_for_edit, remove_skill, restore_skill,
    write_checked,
};

/// FNV-1a, 64 bit, as 16 hex digits. It tells two files apart; it is not a
/// security hash.
pub(crate) fn fnv1a_hex(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a(bytes))
}

pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::fnv1a_hex;

    #[test]
    fn fnv1a_known_values() {
        assert_eq!(fnv1a_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex(b"a"), "af63dc4c8601ec8c");
    }
}
