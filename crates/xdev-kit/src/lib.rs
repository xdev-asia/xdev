//! Agent kit: reads the agent homes, their skills and memory files, and the
//! CLI session logs on this machine. Writes only through `write`.

mod homes;
mod memory;
mod skills;
mod write;

pub use homes::{Agent, Home, HomeSource, KitError, approx_tokens, homes};
pub use memory::{
    IssueKind, MemoryFile, MemoryIssue, MemoryKind, MemorySet, project_slug, scan_memory,
};
pub use skills::{Skill, SkillScope, scan_skills};
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
