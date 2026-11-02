use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYYMMDD-HHMMSS-xxxx` in UTC. Ids sort by creation time; the hex tail
/// keeps two tasks made in the same second apart.
pub(crate) fn new_id(goal: &str, now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let mut hasher = DefaultHasher::new();
    goal.hash(&mut hasher);
    since.as_nanos().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("{}-{:04x}", stamp(secs), hasher.finish() & 0xffff)
}

fn stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a
/// proleptic Gregorian date.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// What `new_id` makes, so an id from the command line can never name a
/// folder outside `tasks/`.
pub(crate) fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 15 => *c == b'-',
            0..=14 => c.is_ascii_digit(),
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn known_dates() {
        assert_eq!(stamp(0), "19700101-000000");
        // 2000-02-29 is a leap day in a century year divisible by 400.
        assert_eq!(stamp(951_782_400), "20000229-000000");
        assert_eq!(stamp(1_793_491_199), "20261031-235959");
        assert_eq!(stamp(4_107_542_400), "21000301-000000");
    }

    #[test]
    fn id_has_the_shape_and_differs_by_goal() {
        let t = UNIX_EPOCH + Duration::new(1_793_491_199, 5);
        let ids: Vec<String> = ["a", "b", "c", "d"].iter().map(|g| new_id(g, t)).collect();
        assert!(ids[0].starts_with("20261031-235959-"), "{}", ids[0]);
        assert!(ids.iter().all(|id| valid_id(id)));
        // Four 16-bit tails all equal would mean the goal is not hashed.
        assert!(ids.iter().any(|id| *id != ids[0]));
    }

    #[test]
    fn rejects_other_ids() {
        assert!(valid_id("20261102-101500-0a9f"));
        for bad in [
            "",
            "../../etc",
            "20261102-101500-0A9F",
            "20261102_101500-0a9f",
            "20261102-101500-0a9",
            "2026110x-101500-0a9f",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}
