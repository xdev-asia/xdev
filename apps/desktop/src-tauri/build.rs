//! Embeds the build date for the perpetual Pro rule (D-R9): `XDEV_BUILD_DATE`, unix seconds.
//! `SOURCE_DATE_EPOCH` when it is set (reproducible builds), else the start of today (UTC).
//! The license reads it with `option_env!`; a missing value means "unknown".

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let epoch = std::env::var("SOURCE_DATE_EPOCH").ok();
    println!(
        "cargo:rustc-env=XDEV_BUILD_DATE={}",
        build_date(epoch.as_deref(), now())
    );
    tauri_build::build();
}

/// Unix seconds of the build: the epoch when it parses to a positive number, else the start of
/// the day `now` falls on.
fn build_date(source_date_epoch: Option<&str>, now: i64) -> i64 {
    source_date_epoch
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(now - now.rem_euclid(86_400))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}
