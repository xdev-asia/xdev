//! Signed updates from GitHub Releases (ADR 0005). Rust drives the updater and
//! notification plugins so the webview needs no permission and no extra JS
//! package. Updates download in the background and install on restart or quit,
//! so agents that are running are never cut off.

use crate::applog;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::commands::CmdError;
use crate::settings::{SettingsSection, UpdateChannel};
use crate::settings_store;

const RECHECK: Duration = Duration::from_secs(6 * 3600);
const READY_EVENT: &str = "update-ready";
const PHASE_EVENT: &str = "update-phase";

const STABLE_ENDPOINT: &str =
    "https://github.com/xdev-asia/xdev-ide/releases/latest/download/latest.json";
const RC_ENDPOINT: &str =
    "https://github.com/xdev-asia/xdev-ide/releases/download/rc-latest/latest.json";

const REPO: &str = "xdev-asia/xdev-ide";
const RELEASES_URL: &str = "https://api.github.com/repos/xdev-asia/xdev-ide/releases?per_page=50";
/// The moving release the release candidate channel reads its manifest from.
const RC_TAG: &str = "rc-latest";
/// The most builds the picker lists.
const MAX_BUILDS: usize = 20;
const RELEASES_TIMEOUT: Duration = Duration::from_secs(15);

/// The manifest a channel follows. The stable one is also in `tauri.conf.json`.
pub fn endpoint(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => STABLE_ENDPOINT,
        UpdateChannel::Rc => RC_ENDPOINT,
    }
}

/// Whether `tag` is safe to put in a manifest url: release tags are made of
/// letters, digits and `. - _ +`.
fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 100
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

/// The manifest of one release, built the way the channel manifests are.
pub fn tag_endpoint(tag: &str) -> Option<String> {
    valid_tag(tag).then(|| format!("https://github.com/{REPO}/releases/download/{tag}/latest.json"))
}

/// Whether a release found by a check is offered now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Offer {
    Now,
    /// Not before this moment.
    On(OffsetDateTime),
}

/// A release published at `pub_date` is offered once it is `delay_days` old.
/// No date, or no delay, offers it at once.
pub fn offer(pub_date: Option<OffsetDateTime>, now: OffsetDateTime, delay_days: u8) -> Offer {
    let Some(published) = pub_date else {
        return Offer::Now;
    };
    let on = published + time::Duration::days(i64::from(delay_days));
    if delay_days == 0 || now >= on {
        Offer::Now
    } else {
        Offer::On(on)
    }
}

/// A manifest `pub_date`; `None` when it is not an RFC 3339 date. The updater
/// plugin parses the real one and hands over an `Option`.
#[cfg(test)]
fn parse_pub_date(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

/// A release that was found but is held back by the update delay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeferral {
    version: String,
    /// RFC 3339.
    offer_on: String,
}

/// The release the last check held back, if it did.
#[derive(Default)]
pub struct Deferred(Mutex<Option<UpdateDeferral>>);

impl Deferred {
    fn get(&self) -> Option<UpdateDeferral> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, next: Option<UpdateDeferral>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }
}

/// One entry of the release build picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReleaseBuild {
    tag: String,
    /// RFC 3339, as GitHub sends it.
    published_at: Option<String>,
    prerelease: bool,
    /// Older than the running version: installing it is a downgrade.
    older: bool,
}

#[derive(serde::Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
}

/// The builds the picker lists, newest first as GitHub sorts them: no drafts,
/// no release candidates unless `rc`, and not the moving channel release.
pub fn parse_releases(
    json: &str,
    rc: bool,
    running: Option<&semver::Version>,
) -> Result<Vec<ReleaseBuild>, String> {
    let raw: Vec<RawRelease> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(raw
        .into_iter()
        .filter(|r| {
            !r.draft && (rc || !r.prerelease) && r.tag_name != RC_TAG && valid_tag(&r.tag_name)
        })
        .take(MAX_BUILDS)
        .map(|r| {
            let version = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok();
            ReleaseBuild {
                older: matches!((&version, running), (Some(v), Some(now)) if v < now),
                tag: r.tag_name,
                published_at: r.published_at,
                prerelease: r.prerelease,
            }
        })
        .collect())
}

/// Why the releases could not be listed; the UI words each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseListError {
    Offline,
    RateLimit,
    Failed,
}

/// What listing the releases ended in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReleaseList {
    Loaded {
        builds: Vec<ReleaseBuild>,
    },
    Error {
        reason: ReleaseListError,
        detail: Option<String>,
    },
}

/// What an HTTP status from the releases API means. GitHub answers a spent
/// quota with 429, or with 403 and no requests remaining.
fn status_error(status: u16, remaining: Option<&str>) -> ReleaseListError {
    match (status, remaining) {
        (429, _) | (403, Some("0")) => ReleaseListError::RateLimit,
        _ => ReleaseListError::Failed,
    }
}

async fn fetch_releases(app: &AppHandle, rc: bool) -> ReleaseList {
    let failed = |reason, detail: String| ReleaseList::Error {
        reason,
        detail: Some(detail),
    };
    let running = app.package_info().version.clone();
    let client = match reqwest::Client::builder()
        .user_agent(format!("xdev-desktop/{running}"))
        .timeout(RELEASES_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return failed(ReleaseListError::Failed, e.to_string()),
    };
    let response = match client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            return failed(ReleaseListError::Offline, e.to_string());
        }
        Err(e) => return failed(ReleaseListError::Failed, e.to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        let remaining = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok());
        return failed(
            status_error(status.as_u16(), remaining),
            format!("HTTP {status}"),
        );
    }
    let body = match response.text().await {
        Ok(b) => b,
        Err(e) => return failed(ReleaseListError::Failed, e.to_string()),
    };
    match parse_releases(&body, rc, Some(&running)) {
        Ok(builds) => ReleaseList::Loaded { builds },
        Err(e) => failed(ReleaseListError::Failed, e),
    }
}

/// The download progress in whole percent; `None` while the size is unknown.
fn percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    Some((downloaded.saturating_mul(100) / total).min(100) as u8)
}

/// What a failed check reads as. No release on the release candidate feed is
/// normal until one is published, so it is "up to date", not an error.
fn error_phase(channel: UpdateChannel, e: &tauri_plugin_updater::Error) -> UpdatePhase {
    match (channel, e) {
        (UpdateChannel::Rc, tauri_plugin_updater::Error::ReleaseNotFound) => UpdatePhase::UpToDate,
        _ => UpdatePhase::Error {
            detail: e.to_string(),
        },
    }
}

/// The phase a check that found `found` (if anything) ends in.
fn found_phase(found: Option<UpdateInfo>) -> UpdatePhase {
    match found {
        None => UpdatePhase::UpToDate,
        Some(i) => UpdatePhase::Ready {
            version: i.version,
            notes: i.notes,
        },
    }
}

/// The phase now, shared by the 6 hour loop and the commands. A check or a
/// download in flight is the single flight: a second one gets the phase back.
pub struct Phase(Mutex<UpdatePhase>);

impl Default for Phase {
    fn default() -> Self {
        Self(Mutex::new(UpdatePhase::Idle))
    }
}

impl Phase {
    fn get(&self) -> UpdatePhase {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, next: UpdatePhase) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    /// Moves to `Checking` unless a check or download is already running; then
    /// the running one's phase is the error.
    fn begin(&self) -> Result<(), UpdatePhase> {
        let mut now = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &*now {
            UpdatePhase::Checking | UpdatePhase::Downloading { .. } => Err(now.clone()),
            _ => {
                *now = UpdatePhase::Checking;
                Ok(())
            }
        }
    }
}

fn publish(app: &AppHandle, next: UpdatePhase) {
    app.state::<Phase>().set(next.clone());
    let _ = app.emit(PHASE_EVENT, next);
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Where a manual or background update check stands; the UI shows it in
/// Settings → General → Updates. Sent as the `update-phase` event on change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
    Error {
        detail: String,
    },
}

/// The downloaded, verified-on-install update waiting for a restart or quit.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

impl Pending {
    fn take(&self) -> Option<(Update, Vec<u8>)> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn put(&self, update: Update, bytes: Vec<u8>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    }

    fn version(&self) -> Option<String> {
        let pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().map(|(u, _)| u.version.clone())
    }

    fn info(&self) -> Option<UpdateInfo> {
        let pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().map(|(u, _)| info(u))
    }
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    }
}

/// `check()` only reports releases newer than the running app, so any version
/// other than the pending one is worth downloading.
fn needs_download(pending: Option<&str>, found: &str) -> bool {
    pending != Some(found)
}

/// Checks now and every [`RECHECK`] on its own thread, so a slow download
/// never holds up the async runtime the commands share.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        loop {
            let phase = tauri::async_runtime::block_on(run_check(&app, None));
            // Offline or no release yet: try again next round, quietly.
            if let Some(UpdatePhase::Error { detail }) = &phase {
                applog::warn("update check failed", detail);
            }
            thread::sleep(RECHECK);
        }
    });
}

/// One check, and the download of what it finds, publishing every phase.
/// `None` when another check is already running. With a `tag` (already
/// validated) the check reads that release's manifest and takes any other
/// version, older ones too; it ignores the update delay.
async fn run_check(app: &AppHandle, tag: Option<&str>) -> Option<UpdatePhase> {
    let phases = app.state::<Phase>();
    if phases.begin().is_err() {
        return None;
    }
    publish(app, UpdatePhase::Checking);
    app.state::<Deferred>().set(None);
    let channel = settings_store::read(app).shell.update_channel;
    let end = match check_once(app, channel, tag).await {
        Ok(phase) => phase,
        // A build that was picked by hand and has no manifest is an error on any channel.
        Err(e) if tag.is_some() => UpdatePhase::Error {
            detail: e.to_string(),
        },
        Err(e) => error_phase(channel, &e),
    };
    publish(app, end.clone());
    Some(end)
}

async fn check_once(
    app: &AppHandle,
    channel: UpdateChannel,
    tag: Option<&str>,
) -> tauri_plugin_updater::Result<UpdatePhase> {
    let updater = match (tag, channel) {
        (Some(tag), _) => {
            let url = tag_endpoint(tag).expect("a validated tag");
            let url = tauri::Url::parse(&url).expect("a valid url from a validated tag");
            app.updater_builder()
                .endpoints(vec![url])?
                .version_comparator(|current, remote| remote.version != current)
                .build()?
        }
        (None, UpdateChannel::Stable) => app.updater()?,
        (None, UpdateChannel::Rc) => {
            let url = tauri::Url::parse(endpoint(channel)).expect("a fixed, valid url");
            app.updater_builder().endpoints(vec![url])?.build()?
        }
    };
    let Some(update) = updater.check().await? else {
        return Ok(UpdatePhase::UpToDate);
    };
    if tag.is_none() {
        let delay = settings_store::read(app).shell.update_delay_days;
        if let Offer::On(on) = offer(update.date, OffsetDateTime::now_utc(), delay) {
            app.state::<Deferred>().set(Some(UpdateDeferral {
                version: update.version.clone(),
                offer_on: on.format(&Rfc3339).unwrap_or_default(),
            }));
            return Ok(UpdatePhase::UpToDate);
        }
    }
    let pending = app.state::<Pending>();
    if !needs_download(pending.version().as_deref(), &update.version) {
        return Ok(found_phase(pending.info()));
    }
    let version = update.version.clone();
    publish(
        app,
        UpdatePhase::Downloading {
            version: version.clone(),
            percent: None,
        },
    );
    let mut downloaded = 0u64;
    let mut shown = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let now = percent(downloaded, total);
                if now != shown {
                    shown = now;
                    publish(
                        app,
                        UpdatePhase::Downloading {
                            version: version.clone(),
                            percent: now,
                        },
                    );
                }
            },
            || {},
        )
        .await?;
    let ready = info(&update);
    pending.put(update, bytes);
    let _ = app.emit(READY_EVENT, ready.clone());
    Ok(found_phase(Some(ready)))
}

/// Installs whatever is pending; called as the app exits.
pub fn install_pending(app: &AppHandle) {
    if let Some((update, bytes)) = app.state::<Pending>().take()
        && let Err(e) = update.install(bytes)
    {
        applog::warn("update install on quit failed", &e.to_string());
    }
}

/// The downloaded update ready to install, if any.
#[tauri::command]
pub fn update_status(pending: State<'_, Pending>) -> Option<UpdateInfo> {
    pending.info()
}

/// A check the person asked for. `rc` also stores the release candidate
/// channel, which the later checks keep following. Resolves with where the
/// check ended, or the phase of the check that was already running.
#[tauri::command(async)]
pub async fn update_check(app: AppHandle, rc: bool) -> Result<UpdatePhase, CmdError> {
    if rc && settings_store::read(&app).shell.update_channel != UpdateChannel::Rc {
        settings_store::write(&app, &[SettingsSection::Shell], |s| {
            s.shell.update_channel = UpdateChannel::Rc;
        })?;
    }
    Ok(match run_check(&app, None).await {
        Some(phase) => phase,
        None => app.state::<Phase>().get(),
    })
}

/// The release the last check held back for the update delay, if any.
#[tauri::command]
pub fn update_deferred(deferred: State<'_, Deferred>) -> Option<UpdateDeferral> {
    deferred.get()
}

/// The recent releases of the app, for the build picker. The release candidate
/// channel also lists prereleases.
#[tauri::command(async)]
pub async fn update_releases(app: AppHandle) -> ReleaseList {
    let rc = settings_store::read(&app).shell.update_channel == UpdateChannel::Rc;
    fetch_releases(&app, rc).await
}

/// Downloads the release `tag` through the same path as a check. Resolves with
/// where it ended, or the phase of the check that was already running.
#[tauri::command(async)]
pub async fn update_install_tag(app: AppHandle, tag: String) -> UpdatePhase {
    if tag_endpoint(&tag).is_none() {
        return UpdatePhase::Error {
            detail: format!("invalid release tag: {tag}"),
        };
    }
    match run_check(&app, Some(&tag)).await {
        Some(phase) => phase,
        None => app.state::<Phase>().get(),
    }
}

/// Where the update check stands now.
#[tauri::command]
pub fn update_phase(phase: State<'_, Phase>) -> UpdatePhase {
    phase.get()
}

/// An OS notification; the UI passes the text so it is in the user's language.
#[tauri::command]
pub fn update_notify(app: AppHandle, title: String, body: String) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        applog::warn("notification failed", &e.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_only_a_version_not_already_pending() {
        assert!(needs_download(None, "0.3.0"));
        assert!(!needs_download(Some("0.3.0"), "0.3.0"));
        assert!(needs_download(Some("0.3.0"), "0.3.1"));
    }

    #[test]
    fn each_channel_has_its_own_manifest() {
        assert_eq!(
            endpoint(UpdateChannel::Stable),
            "https://github.com/xdev-asia/xdev-ide/releases/latest/download/latest.json"
        );
        assert_eq!(
            endpoint(UpdateChannel::Rc),
            "https://github.com/xdev-asia/xdev-ide/releases/download/rc-latest/latest.json"
        );
    }

    fn at(text: &str) -> OffsetDateTime {
        parse_pub_date(text).unwrap()
    }

    #[test]
    fn no_delay_offers_every_release_at_once() {
        let now = at("2026-01-10T12:00:00Z");
        assert_eq!(offer(Some(now), now, 0), Offer::Now);
        assert_eq!(offer(Some(at("2026-01-10T11:59:59Z")), now, 0), Offer::Now);
        // Even a date in the future.
        assert_eq!(offer(Some(at("2026-02-01T00:00:00Z")), now, 0), Offer::Now);
    }

    #[test]
    fn a_release_is_held_back_until_it_is_old_enough() {
        let published = at("2026-01-10T00:00:00Z");
        for (days, ready) in [
            (1, "2026-01-11T00:00:00Z"),
            (3, "2026-01-13T00:00:00Z"),
            (7, "2026-01-17T00:00:00Z"),
        ] {
            let on = at(ready);
            let just_before = on - time::Duration::seconds(1);
            assert_eq!(
                offer(Some(published), published, days),
                Offer::On(on),
                "{days} days, at once"
            );
            assert_eq!(
                offer(Some(published), just_before, days),
                Offer::On(on),
                "{days} days, a second early"
            );
            // The exact boundary counts as old enough.
            assert_eq!(
                offer(Some(published), on, days),
                Offer::Now,
                "{days} days, boundary"
            );
            assert_eq!(
                offer(Some(published), on + time::Duration::days(30), days),
                Offer::Now
            );
        }
    }

    #[test]
    fn a_missing_or_unparsable_date_is_offered_at_once() {
        let now = at("2026-01-10T12:00:00Z");
        assert_eq!(offer(None, now, 7), Offer::Now);
        assert_eq!(parse_pub_date("last tuesday"), None);
        assert_eq!(parse_pub_date(""), None);
        assert_eq!(offer(parse_pub_date("last tuesday"), now, 7), Offer::Now);
        assert!(parse_pub_date("2026-01-10T00:00:00Z").is_some());
    }

    #[test]
    fn a_release_dated_in_the_future_waits_from_its_own_date() {
        let now = at("2026-01-10T00:00:00Z");
        let published = at("2026-01-12T00:00:00Z");
        assert_eq!(
            offer(Some(published), now, 1),
            Offer::On(at("2026-01-13T00:00:00Z"))
        );
        assert_eq!(
            offer(Some(published), now, 7),
            Offer::On(at("2026-01-19T00:00:00Z"))
        );
    }

    #[test]
    fn a_tag_has_a_manifest_next_to_the_channel_ones() {
        assert_eq!(
            tag_endpoint(RC_TAG).as_deref(),
            Some(endpoint(UpdateChannel::Rc))
        );
        assert_eq!(
            tag_endpoint("v0.3.1").as_deref(),
            Some("https://github.com/xdev-asia/xdev-ide/releases/download/v0.3.1/latest.json")
        );
        assert!(tag_endpoint("v0.4.0-rc.1+build_2").is_some());
        for bad in [
            "",
            "a/b",
            "..%2f",
            "v1 0",
            "v1?x=1",
            "v1#",
            &"a".repeat(101),
        ] {
            assert_eq!(tag_endpoint(bad), None, "{bad:?}");
        }
        assert!(RELEASES_URL.contains(REPO));
        assert!(endpoint(UpdateChannel::Stable).contains(REPO));
    }

    const RELEASES: &str = r#"[
        { "tag_name": "v0.5.0-rc.1", "draft": false, "prerelease": true, "published_at": "2026-03-01T10:00:00Z", "name": "x" },
        { "tag_name": "rc-latest", "draft": false, "prerelease": true, "published_at": "2026-03-01T10:00:00Z" },
        { "tag_name": "v0.4.2", "draft": true, "prerelease": false, "published_at": null },
        { "tag_name": "v0.4.1", "draft": false, "prerelease": false, "published_at": "2026-02-20T08:30:00Z" },
        { "tag_name": "v0.3.0", "prerelease": false, "published_at": "2026-01-05T08:30:00Z" },
        { "tag_name": "nightly build", "prerelease": false, "published_at": "2026-01-04T00:00:00Z" },
        { "tag_name": "weekly", "prerelease": false }
    ]"#;

    fn running(text: &str) -> semver::Version {
        semver::Version::parse(text).unwrap()
    }

    #[test]
    fn the_stable_list_has_no_drafts_prereleases_or_the_channel_release() {
        let builds = parse_releases(RELEASES, false, Some(&running("0.4.0"))).unwrap();
        let tags: Vec<_> = builds.iter().map(|b| b.tag.as_str()).collect();
        assert_eq!(tags, ["v0.4.1", "v0.3.0", "weekly"]);
        assert_eq!(
            builds[0].published_at.as_deref(),
            Some("2026-02-20T08:30:00Z")
        );
        assert!(!builds[0].older);
        assert!(builds[1].older);
        // Not a version: not known to be a downgrade.
        assert!(!builds[2].older);
        assert_eq!(builds[2].published_at, None);
    }

    #[test]
    fn the_rc_list_adds_prereleases_and_marks_them() {
        let builds = parse_releases(RELEASES, true, Some(&running("0.4.1"))).unwrap();
        let tags: Vec<_> = builds
            .iter()
            .map(|b| (b.tag.as_str(), b.prerelease))
            .collect();
        assert_eq!(
            tags,
            [
                ("v0.5.0-rc.1", true),
                ("v0.4.1", false),
                ("v0.3.0", false),
                ("weekly", false)
            ]
        );
        assert!(!builds[0].older && !builds[1].older && builds[2].older);
        // A prerelease of the running version is older than it.
        let pre = r#"[{ "tag_name": "v0.4.1-rc.2", "prerelease": true }]"#;
        assert!(parse_releases(pre, true, Some(&running("0.4.1"))).unwrap()[0].older);
        // Without a running version nothing is a downgrade.
        assert!(
            !parse_releases(RELEASES, true, None)
                .unwrap()
                .iter()
                .any(|b| b.older)
        );
    }

    #[test]
    fn the_list_is_capped_and_bad_json_is_an_error() {
        let many: Vec<_> = (0..50)
            .map(|i| format!(r#"{{ "tag_name": "v1.0.{i}" }}"#))
            .collect();
        let json = format!("[{}]", many.join(","));
        let builds = parse_releases(&json, false, None).unwrap();
        assert_eq!(builds.len(), MAX_BUILDS);
        assert_eq!(builds[0].tag, "v1.0.0");
        assert_eq!(parse_releases("[]", false, None).unwrap(), []);
        assert!(parse_releases("not json", false, None).is_err());
        // The API answers an object, not a list, when it refuses.
        assert!(
            parse_releases(r#"{ "message": "API rate limit exceeded" }"#, false, None).is_err()
        );
    }

    #[test]
    fn http_statuses_read_as_a_rate_limit_or_a_failure() {
        assert_eq!(status_error(429, None), ReleaseListError::RateLimit);
        assert_eq!(status_error(403, Some("0")), ReleaseListError::RateLimit);
        assert_eq!(status_error(403, Some("12")), ReleaseListError::Failed);
        assert_eq!(status_error(403, None), ReleaseListError::Failed);
        assert_eq!(status_error(404, None), ReleaseListError::Failed);
        assert_eq!(status_error(500, Some("0")), ReleaseListError::Failed);
    }

    #[test]
    fn the_release_list_serialises_with_a_kind_tag() {
        let json = serde_json::to_value(
            parse_releases(RELEASES, false, None)
                .map(|builds| ReleaseList::Loaded { builds })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["kind"], "loaded");
        assert_eq!(json["builds"][0]["publishedAt"], "2026-02-20T08:30:00Z");
        let err = serde_json::to_value(ReleaseList::Error {
            reason: ReleaseListError::RateLimit,
            detail: None,
        })
        .unwrap();
        assert_eq!(err["kind"], "error");
        assert_eq!(err["reason"], "rate-limit");
    }

    #[test]
    fn the_stable_endpoint_is_the_one_in_the_config() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(endpoint(UpdateChannel::Stable)));
    }

    #[test]
    fn percent_comes_from_the_chunks_and_the_total() {
        assert_eq!(percent(0, Some(200)), Some(0));
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(200, Some(200)), Some(100));
        assert_eq!(percent(500, Some(200)), Some(100));
        assert_eq!(percent(10, None), None);
        assert_eq!(percent(10, Some(0)), None);
    }

    #[test]
    fn no_release_on_the_rc_feed_reads_as_up_to_date() {
        let missing = tauri_plugin_updater::Error::ReleaseNotFound;
        assert_eq!(
            error_phase(UpdateChannel::Rc, &missing),
            UpdatePhase::UpToDate
        );
        assert!(matches!(
            error_phase(UpdateChannel::Stable, &missing),
            UpdatePhase::Error { .. }
        ));
    }

    #[test]
    fn a_check_that_finds_nothing_ends_up_to_date() {
        assert_eq!(found_phase(None), UpdatePhase::UpToDate);
        let ready = found_phase(Some(UpdateInfo {
            version: "0.4.0".into(),
            notes: Some("fixes".into()),
        }));
        assert_eq!(
            ready,
            UpdatePhase::Ready {
                version: "0.4.0".into(),
                notes: Some("fixes".into())
            }
        );
    }

    #[test]
    fn a_second_check_gets_the_running_phase_back() {
        let phase = Phase::default();
        assert_eq!(phase.get(), UpdatePhase::Idle);
        assert_eq!(phase.begin(), Ok(()));
        assert_eq!(phase.begin(), Err(UpdatePhase::Checking));
        let downloading = UpdatePhase::Downloading {
            version: "0.4.0".into(),
            percent: Some(40),
        };
        phase.set(downloading.clone());
        assert_eq!(phase.begin(), Err(downloading));
        // Once it ended, a new check may start.
        phase.set(UpdatePhase::UpToDate);
        assert_eq!(phase.begin(), Ok(()));
        phase.set(UpdatePhase::Ready {
            version: "0.4.0".into(),
            notes: None,
        });
        assert_eq!(phase.begin(), Ok(()));
    }

    #[test]
    fn phases_serialise_with_a_kind_tag() {
        let json = serde_json::to_value(UpdatePhase::Downloading {
            version: "0.4.0".into(),
            percent: None,
        })
        .unwrap();
        assert_eq!(json["kind"], "downloading");
        assert_eq!(json["percent"], serde_json::Value::Null);
        assert_eq!(
            serde_json::to_value(UpdatePhase::UpToDate).unwrap()["kind"],
            "up-to-date"
        );
    }
}
