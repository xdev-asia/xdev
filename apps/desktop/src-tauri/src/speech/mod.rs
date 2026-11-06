//! Voice dictation: the microphone is recorded in Rust, the clip is sent to
//! OpenAI speech-to-text with the user's key, and only the text goes back to
//! the renderer. The key never leaves the OS keychain except as the request
//! header.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use xdev_ai::secrets::{Keychain, SecretStore};
use xdev_ai::transcribe::{
    TRANSCRIBE_HOST, TranscribeError, TranscribeRequest, Transport, UreqTransport, transcribe,
};

use crate::commands::CmdError;
use crate::settings::{DEFAULT_SPEECH_MODEL, SettingsSection, SpeechSettings};
use crate::settings_store;

mod mic;
mod pcm;
mod permission;

use mic::{CpalMic, MicError, MicSource};
use pcm::{Clip, ClipError};
pub use permission::MicPermission;

pub const LEVEL_EVENT: &str = "speech://level";

/// The models Settings → Voice offers.
pub const SPEECH_MODELS: [&str; 3] = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"];

const KEY_PROVIDER: &str = "openai";
/// How often `speech://level` fires while recording.
const LEVEL_EVERY_MS: u64 = 100;

/// What `speech_start` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpeechStarted {
    /// The stored microphone is gone; the default one records.
    pub fallback: bool,
}

/// What `speech_stop` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpeechText {
    pub text: String,
}

/// The payload of `speech://level`, every 100 ms while recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpeechLevel {
    pub elapsed_ms: u32,
    /// Loudness 0..100.
    pub level: u8,
    /// The length cap is reached; the window should call `speech_stop`.
    pub capped: bool,
}

/// One input device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MicDevice {
    pub name: String,
    pub is_default: bool,
}

pub type Emit = Arc<dyn Fn(SpeechLevel) + Send + Sync>;

/// The clip and the level meter, fed from the audio thread. Samples that
/// arrive before the device rate is known wait in `pending`.
struct Recorder {
    clip: Option<Clip>,
    pending: Vec<f32>,
    window: Vec<f32>,
    next_ms: u64,
    capped_sent: bool,
    emit: Emit,
}

impl Recorder {
    fn new(emit: Emit) -> Self {
        Self {
            clip: None,
            pending: Vec::new(),
            window: Vec::new(),
            next_ms: LEVEL_EVERY_MS,
            capped_sent: false,
            emit,
        }
    }

    fn set_rate(&mut self, rate: u32) {
        self.clip = Some(Clip::new(rate));
        let early = std::mem::take(&mut self.pending);
        if !early.is_empty() {
            self.push(&early);
        }
    }

    fn push(&mut self, mono: &[f32]) {
        let Some(clip) = self.clip.as_mut() else {
            self.pending.extend_from_slice(mono);
            return;
        };
        if self.capped_sent {
            return;
        }
        let capped = clip.push(mono);
        self.window.extend_from_slice(mono);
        let elapsed = clip.elapsed_ms();
        if !capped && elapsed < self.next_ms {
            return;
        }
        (self.emit)(SpeechLevel {
            elapsed_ms: u32::try_from(elapsed).unwrap_or(u32::MAX),
            level: pcm::level(&self.window),
            capped,
        });
        self.window.clear();
        self.next_ms = (elapsed / LEVEL_EVERY_MS + 1) * LEVEL_EVERY_MS;
        self.capped_sent = capped;
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Session {
    recorder: Arc<Mutex<Recorder>>,
    running: mic::Running,
    model: String,
    language: Option<String>,
}

/// At most one recording at a time.
#[derive(Default)]
pub struct SpeechState {
    session: Mutex<Option<Session>>,
}

/// A clip taken out of a finished session, ready to upload.
pub struct Taken {
    clip: Clip,
    model: String,
    language: Option<String>,
}

fn err(code: &'static str) -> CmdError {
    CmdError { code, detail: None }
}

fn mic_error(e: MicError) -> CmdError {
    err(e.code())
}

fn transcribe_error(e: TranscribeError) -> CmdError {
    CmdError {
        code: e.code(),
        // The status number only: never the body, which may echo the key.
        detail: match e {
            TranscribeError::Engine(status) => Some(status.to_string()),
            _ => None,
        },
    }
}

fn has_key(store: &dyn SecretStore) -> Result<bool, CmdError> {
    Ok(store.get(KEY_PROVIDER)?.is_some())
}

fn model_or_default(model: &str) -> String {
    if SPEECH_MODELS.contains(&model) {
        model.to_owned()
    } else {
        DEFAULT_SPEECH_MODEL.to_owned()
    }
}

/// The device to open and whether the stored one was missing.
fn pick_device<'a>(mic: &dyn MicSource, wanted: Option<&'a str>) -> (Option<&'a str>, bool) {
    let Some(wanted) = wanted.filter(|d| !d.is_empty()) else {
        return (None, false);
    };
    let known = mic
        .devices()
        .map(|list| list.iter().any(|(n, _)| n == wanted))
        .unwrap_or(false);
    if known {
        (Some(wanted), false)
    } else {
        (None, true)
    }
}

/// Starts recording: `speech_busy`, `speech_no_key` (before the mic opens),
/// then the mic errors.
pub(crate) fn start_with(
    state: &SpeechState,
    store: &dyn SecretStore,
    mic: &dyn MicSource,
    settings: &SpeechSettings,
    emit: Emit,
) -> Result<SpeechStarted, CmdError> {
    let mut session = lock(&state.session);
    if session.is_some() {
        return Err(err("speech_busy"));
    }
    if !has_key(store)? {
        return Err(err("speech_no_key"));
    }
    let (name, fallback) = pick_device(mic, settings.device.as_deref());
    let recorder = Arc::new(Mutex::new(Recorder::new(emit)));
    let sink_recorder = recorder.clone();
    let sink: mic::Sink = Box::new(move |mono: &[f32]| lock(&sink_recorder).push(mono));
    let running = mic.open(name, sink).map_err(mic_error)?;
    lock(&recorder).set_rate(running.rate);
    *session = Some(Session {
        recorder,
        running,
        model: model_or_default(&settings.model),
        language: settings.language.clone().filter(|l| !l.is_empty()),
    });
    Ok(SpeechStarted { fallback })
}

/// Ends the recording and checks the clip: `speech_not_recording`,
/// `speech_too_short`, or `speech_mic_failed` for an all-zero clip.
pub(crate) fn take_clip(state: &SpeechState) -> Result<Taken, CmdError> {
    let session = lock(&state.session)
        .take()
        .ok_or_else(|| err("speech_not_recording"))?;
    let Session {
        recorder,
        running,
        model,
        language,
    } = session;
    // Stops the device; no more samples arrive.
    drop(running);
    let clip = lock(&recorder).clip.take().unwrap_or_else(|| Clip::new(1));
    match clip.check() {
        Ok(()) => Ok(Taken {
            clip,
            model,
            language,
        }),
        Err(ClipError::TooShort) => Err(err("speech_too_short")),
        Err(ClipError::Silent) => Err(err("speech_mic_failed")),
    }
}

/// Sends the clip with the stored key and returns the text.
pub(crate) fn upload(
    store: &dyn SecretStore,
    transport: &dyn Transport,
    taken: Taken,
) -> Result<SpeechText, CmdError> {
    let key = store
        .get(KEY_PROVIDER)?
        .ok_or_else(|| err("speech_no_key"))?;
    let request = TranscribeRequest {
        wav: taken.clip.wav(),
        model: taken.model,
        language: taken.language,
    };
    transcribe(transport, key.expose(), &request)
        .map(|text| SpeechText { text })
        .map_err(transcribe_error)
}

#[cfg(test)]
fn stop_with(
    state: &SpeechState,
    store: &dyn SecretStore,
    transport: &dyn Transport,
) -> Result<SpeechText, CmdError> {
    upload(store, transport, take_clip(state)?)
}

/// Drops the recording without an upload; fine when none runs.
pub(crate) fn cancel(state: &SpeechState) {
    let session = lock(&state.session).take();
    drop(session);
}

fn devices_with(mic: &dyn MicSource) -> Result<Vec<MicDevice>, CmdError> {
    Ok(mic
        .devices()
        .map_err(mic_error)?
        .into_iter()
        .map(|(name, is_default)| MicDevice { name, is_default })
        .collect())
}

/// Trims the stored values; an unknown model reads as the default.
fn normalized(mut settings: SpeechSettings) -> SpeechSettings {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    settings.device = clean(settings.device);
    settings.language = clean(settings.language);
    settings.model = model_or_default(settings.model.trim());
    settings
}

#[tauri::command(async)]
pub fn speech_start(
    app: AppHandle,
    state: State<'_, SpeechState>,
) -> Result<SpeechStarted, CmdError> {
    let settings = settings_store::read(&app).speech;
    let emit: Emit = Arc::new(move |level| {
        let _ = app.emit(LEVEL_EVENT, level);
    });
    start_with(&state, &Keychain, &CpalMic, &settings, emit)
}

#[tauri::command]
pub async fn speech_stop(
    app: AppHandle,
    state: State<'_, SpeechState>,
) -> Result<SpeechText, CmdError> {
    let taken = take_clip(&state)?;
    let network = settings_store::read(&app).network;
    let proxy =
        crate::network::proxy_for_host(&network, TRANSCRIBE_HOST).map(|url| url.to_string());
    tauri::async_runtime::spawn_blocking(move || upload(&Keychain, &UreqTransport { proxy }, taken))
        .await
        .map_err(|_| err("speech_engine"))?
}

#[tauri::command]
pub fn speech_cancel(state: State<'_, SpeechState>) -> Result<(), CmdError> {
    cancel(&state);
    Ok(())
}

#[tauri::command(async)]
pub fn speech_devices() -> Result<Vec<MicDevice>, CmdError> {
    devices_with(&CpalMic)
}

#[tauri::command(async)]
pub fn speech_permission() -> MicPermission {
    permission::status()
}

/// Shows the OS prompt where there is one (macOS, first time), then the state.
#[tauri::command(async)]
pub fn speech_permission_request() -> MicPermission {
    permission::request()
}

#[tauri::command(async)]
pub fn speech_open_privacy(app: AppHandle) -> Result<(), CmdError> {
    permission::open_privacy(&app)
}

/// Settings → Voice as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn speech_settings_get(app: AppHandle) -> SpeechSettings {
    settings_store::read(&app).speech
}

#[tauri::command(async)]
pub fn speech_settings_put(
    app: AppHandle,
    settings: SpeechSettings,
) -> Result<SpeechSettings, CmdError> {
    let settings = normalized(settings);
    settings_store::write(&app, &[SettingsSection::Speech], |s| s.speech = settings)
        .map(|s| s.speech)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use xdev_ai::secrets::MemoryStore;
    use xdev_ai::transcribe::TransportError;

    use super::mic::fake::{Behaviour, FakeMic};
    use super::*;

    #[test]
    fn info_plist_has_mic_usage() {
        let plist = include_str!("../../Info.plist");
        let at = plist
            .find("<key>NSMicrophoneUsageDescription</key>")
            .expect("usage key");
        let rest = &plist[at..];
        let open = rest.find("<string>").expect("string") + "<string>".len();
        let close = rest.find("</string>").expect("end of string");
        assert!(!rest[open..close].trim().is_empty());
    }

    #[test]
    fn entitlements_allow_audio_input() {
        let plist = include_str!("../../entitlements.plist");
        let key = "<key>com.apple.security.device.audio-input</key>";
        let at = plist.find(key).expect("audio-input key");
        assert!(plist[at + key.len()..].trim_start().starts_with("<true/>"));
    }

    #[test]
    fn tauri_conf_points_at_entitlements() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["macOS"]["entitlements"],
            "./entitlements.plist"
        );
    }

    struct FakeTransport {
        status: u16,
        body: String,
        bodies: RefCell<Vec<Vec<u8>>>,
    }

    impl FakeTransport {
        fn new(status: u16, body: &str) -> Self {
            Self {
                status,
                body: body.to_owned(),
                bodies: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            self.bodies.borrow().len()
        }
    }

    impl Transport for FakeTransport {
        fn post(
            &self,
            _url: &str,
            _headers: &[(&str, String)],
            body: Vec<u8>,
        ) -> Result<(u16, String), TransportError> {
            self.bodies.borrow_mut().push(body);
            Ok((self.status, self.body.clone()))
        }
    }

    fn keyed() -> MemoryStore {
        let mut store = MemoryStore::default();
        store.set("openai", "sk-test").unwrap();
        store
    }

    fn quiet() -> Emit {
        Arc::new(|_| {})
    }

    fn collecting() -> (Emit, Arc<Mutex<Vec<SpeechLevel>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (Arc::new(move |l| sink.lock().unwrap().push(l)), seen)
    }

    fn tone(seconds: f32, rate: u32) -> Vec<f32> {
        let n = (seconds * rate as f32) as usize;
        (0..n)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5)
            .collect()
    }

    fn start(state: &SpeechState, mic: &FakeMic) -> Result<SpeechStarted, CmdError> {
        start_with(state, &keyed(), mic, &SpeechSettings::default(), quiet())
    }

    #[test]
    fn no_key_fails_before_the_mic_opens() {
        let mic = FakeMic::new(Behaviour::Ok);
        let e = start_with(
            &SpeechState::default(),
            &MemoryStore::default(),
            &mic,
            &SpeechSettings::default(),
            quiet(),
        )
        .unwrap_err();
        assert_eq!(e.code, "speech_no_key");
        assert_eq!(mic.open_count(), 0);
    }

    #[test]
    fn mic_errors_map_to_codes() {
        for (behaviour, code) in [
            (Behaviour::NoDevice, "speech_no_mic"),
            (Behaviour::Denied, "speech_mic_denied"),
            (Behaviour::BuildError, "speech_mic_failed"),
        ] {
            let state = SpeechState::default();
            let e = start(&state, &FakeMic::new(behaviour)).unwrap_err();
            assert_eq!(e.code, code);
            assert!(lock(&state.session).is_none());
        }
    }

    #[test]
    fn second_start_is_busy() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        start(&state, &mic).unwrap();
        assert_eq!(start(&state, &mic).unwrap_err().code, "speech_busy");
        assert_eq!(mic.open_count(), 1);
    }

    #[test]
    fn missing_device_falls_back_to_the_default() {
        let mic = FakeMic::new(Behaviour::Ok);
        let settings = SpeechSettings {
            device: Some("Gone".to_owned()),
            ..SpeechSettings::default()
        };
        let started =
            start_with(&SpeechState::default(), &keyed(), &mic, &settings, quiet()).unwrap();
        assert_eq!(started, SpeechStarted { fallback: true });
        assert_eq!(mic.opened.lock().unwrap()[0], None);

        let settings = SpeechSettings {
            device: Some("Built-in".to_owned()),
            ..SpeechSettings::default()
        };
        let started =
            start_with(&SpeechState::default(), &keyed(), &mic, &settings, quiet()).unwrap();
        assert_eq!(started, SpeechStarted { fallback: false });
        assert_eq!(mic.opened.lock().unwrap()[1].as_deref(), Some("Built-in"));
    }

    #[test]
    fn one_second_of_tone_is_transcribed() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        start(&state, &mic).unwrap();
        mic.feed_chunks(&tone(1.0, 16_000));
        let transport = FakeTransport::new(200, r#"{"text":"hi"}"#);
        let text = stop_with(&state, &keyed(), &transport).unwrap();
        assert_eq!(text, SpeechText { text: "hi".into() });
        let bodies = transport.bodies.borrow();
        assert_eq!(bodies.len(), 1);
        let riff = bodies[0].windows(4).position(|w| w == b"RIFF").unwrap();
        let wav = &bodies[0][riff..];
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data_len, 32_000);
        assert!(wav.len() >= 44 + 32_000);
        assert!(lock(&state.session).is_none());
    }

    #[test]
    fn resamples_a_48k_device() {
        let state = SpeechState::default();
        let mut mic = FakeMic::new(Behaviour::Ok);
        mic.rate = 48_000;
        start(&state, &mic).unwrap();
        mic.feed_chunks(&tone(1.0, 48_000));
        let taken = take_clip(&state).unwrap();
        assert_eq!(taken.clip.wav().len(), 44 + 32_000);
    }

    #[test]
    fn short_and_silent_clips_are_not_uploaded() {
        let transport = FakeTransport::new(200, r#"{"text":"hi"}"#);
        for (samples, code) in [
            (tone(0.2, 16_000), "speech_too_short"),
            (vec![0.0; 16_000], "speech_mic_failed"),
        ] {
            let state = SpeechState::default();
            let mic = FakeMic::new(Behaviour::Ok);
            start(&state, &mic).unwrap();
            mic.feed_chunks(&samples);
            let e = stop_with(&state, &keyed(), &transport).unwrap_err();
            assert_eq!(e.code, code);
            assert!(lock(&state.session).is_none());
        }
        assert_eq!(transport.calls(), 0);
    }

    #[test]
    fn cancel_drops_the_recording() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        start(&state, &mic).unwrap();
        mic.feed_chunks(&tone(1.0, 16_000));
        cancel(&state);
        assert!(lock(&state.session).is_none());
        let transport = FakeTransport::new(200, r#"{"text":"hi"}"#);
        assert_eq!(
            stop_with(&state, &keyed(), &transport).unwrap_err().code,
            "speech_not_recording"
        );
        assert_eq!(transport.calls(), 0);
        cancel(&state);
        // The device was released: a new start works.
        start(&state, &mic).unwrap();
    }

    #[test]
    fn engine_errors_carry_the_status_only() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        start(&state, &mic).unwrap();
        mic.feed_chunks(&tone(1.0, 16_000));
        let transport = FakeTransport::new(500, "bad key sk-test");
        let e = stop_with(&state, &keyed(), &transport).unwrap_err();
        assert_eq!(e.code, "speech_engine");
        assert_eq!(e.detail.as_deref(), Some("500"));
        assert!(!format!("{e:?}").contains("sk-test"));
    }

    #[test]
    fn upload_without_a_key_is_no_key() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        start(&state, &mic).unwrap();
        mic.feed_chunks(&tone(1.0, 16_000));
        let transport = FakeTransport::new(200, r#"{"text":"hi"}"#);
        let e = stop_with(&state, &MemoryStore::default(), &transport).unwrap_err();
        assert_eq!(e.code, "speech_no_key");
        assert_eq!(transport.calls(), 0);
    }

    #[test]
    fn level_events_every_100ms() {
        let state = SpeechState::default();
        let mic = FakeMic::new(Behaviour::Ok);
        let (emit, seen) = collecting();
        start_with(&state, &keyed(), &mic, &SpeechSettings::default(), emit).unwrap();
        mic.feed_chunks(&tone(1.0, 16_000));
        let seen = seen.lock().unwrap();
        assert!((9..=11).contains(&seen.len()), "{}", seen.len());
        assert!(seen.windows(2).all(|w| w[0].elapsed_ms < w[1].elapsed_ms));
        assert!(seen.iter().all(|l| !l.capped && l.level > 0));
    }

    #[test]
    fn the_cap_emits_once() {
        let state = SpeechState::default();
        let mut mic = FakeMic::new(Behaviour::Ok);
        mic.rate = 1_000;
        let (emit, seen) = collecting();
        start_with(&state, &keyed(), &mic, &SpeechSettings::default(), emit).unwrap();
        mic.feed_chunks(&vec![0.3; 121_000]);
        let seen = seen.lock().unwrap();
        let capped: Vec<_> = seen.iter().filter(|l| l.capped).collect();
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].elapsed_ms, 120_000);
        assert!(seen.last().unwrap().capped);
    }

    #[test]
    fn devices_and_settings() {
        let mut mic = FakeMic::new(Behaviour::Ok);
        mic.names = vec!["A".into(), "B".into()];
        assert_eq!(
            devices_with(&mic).unwrap(),
            vec![
                MicDevice {
                    name: "A".into(),
                    is_default: true
                },
                MicDevice {
                    name: "B".into(),
                    is_default: false
                },
            ]
        );
        let s = normalized(SpeechSettings {
            device: Some("  ".into()),
            language: Some(" vi ".into()),
            model: "nope".into(),
            ..SpeechSettings::default()
        });
        assert_eq!(s.device, None);
        assert_eq!(s.language.as_deref(), Some("vi"));
        assert_eq!(s.model, DEFAULT_SPEECH_MODEL);
        assert!(SPEECH_MODELS.contains(&DEFAULT_SPEECH_MODEL));
    }
}
