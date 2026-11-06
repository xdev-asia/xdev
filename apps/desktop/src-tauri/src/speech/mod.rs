//! Voice dictation: the microphone is recorded in Rust, the clip is sent to
//! OpenAI speech-to-text with the user's key, and only the text goes back to
//! the renderer.

mod pcm;
mod permission;

#[cfg(test)]
mod tests {
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
}
