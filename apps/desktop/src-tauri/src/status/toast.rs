//! Status notifications on Windows. The notification plugin shows its toasts
//! without a tag, and Action Center removes a toast one by one only by tag
//! (an empty tag is refused), so status toasts are shown here, each with a
//! tag of its own in one group, and removed by that tag.

#[cfg(windows)]
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
    core::{HSTRING, IInspectable},
};

/// The group every status toast is in.
#[cfg_attr(not(windows), allow(dead_code))]
const GROUP: &str = "xdev-status";
/// What the plugin shows toasts under in a build run from `target`, which
/// has no Start menu shortcut carrying the app's own id.
#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/// The app id of an installed build: `identifier`, unless the executable runs
/// from `target\debug` or `target\release` (a dev run), as the plugin decides.
#[cfg_attr(not(windows), allow(dead_code))]
fn installed_app_id<'a>(exe_dir: &str, identifier: &'a str) -> Option<&'a str> {
    let dev = ["\\target\\debug", "\\target\\release"]
        .iter()
        .any(|end| exe_dir.ends_with(end));
    (!dev).then_some(identifier)
}

/// The tag of notification `id` in this run. `run` keeps a tag from replacing
/// a toast an earlier run left in Action Center. 16 characters, the most
/// older Windows 10 builds take.
#[cfg_attr(not(windows), allow(dead_code))]
fn tag(run: u32, id: i32) -> String {
    format!("{run:08x}{:08x}", id.cast_unsigned())
}

/// The toast's XML: title and body, no sound (the app plays its own) and the
/// short duration, as the plugin shows it.
#[cfg_attr(not(windows), allow(dead_code))]
fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast duration=\"short\"><visual><binding template=\"ToastGeneric\">\
         <text id=\"1\">{}</text><text id=\"2\">{}</text>\
         </binding></visual><audio silent=\"true\"/></toast>",
        escape(title),
        escape(body)
    )
}

/// `text` as XML character data. Characters XML cannot carry are dropped.
#[cfg_attr(not(windows), allow(dead_code))]
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if c < ' ' || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// A number of this run, the same for every call.
#[cfg(windows)]
fn run() -> u32 {
    use std::sync::OnceLock;
    static RUN: OnceLock<u32> = OnceLock::new();
    // The low 32 bits of a random uuid.
    *RUN.get_or_init(|| uuid::Uuid::new_v4().as_u128() as u32)
}

/// The installed app id, or `None` in a dev run.
#[cfg(windows)]
fn app_id(app: &AppHandle) -> Option<String> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    let dir = exe.parent()?.display().to_string();
    installed_app_id(&dir, &app.config().identifier).map(str::to_owned)
}

/// Shows notification `id` for a pane; a click on it is reported as
/// `CLICK_EVENT` with that pane.
#[cfg(windows)]
pub fn show(
    app: &AppHandle,
    id: i32,
    title: &str,
    body: &str,
    pty_id: &str,
) -> windows::core::Result<()> {
    let app_id = app_id(app).unwrap_or_else(|| POWERSHELL_APP_ID.to_owned());
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.SetTag(&HSTRING::from(tag(run(), id)))?;
    toast.SetGroup(&HSTRING::from(GROUP))?;
    let emitter = app.clone();
    let pty_id = pty_id.to_owned();
    let clicked = TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
        let click = super::NotificationClick {
            pty_id: pty_id.clone(),
        };
        let _ = emitter.emit(super::CLICK_EVENT, click);
        Ok(())
    });
    toast.Activated(&clicked)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
}

/// Removes notifications `ids` from Action Center; one already gone is no
/// error. Skipped in a dev run, where toasts go out under PowerShell's id.
#[cfg(windows)]
pub fn remove(app: &AppHandle, ids: &[i32]) -> windows::core::Result<()> {
    let Some(app_id) = app_id(app) else {
        return Ok(());
    };
    let history = ToastNotificationManager::History()?;
    let (group, app_id) = (HSTRING::from(GROUP), HSTRING::from(app_id));
    let mut result = Ok(());
    for &id in ids {
        let removed =
            history.RemoveGroupedTagWithId(&HSTRING::from(tag(run(), id)), &group, &app_id);
        // One failing does not keep the others.
        if removed.is_err() {
            result = removed;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_runs_have_no_installed_app_id() {
        let id = "asia.xdev.desktop";
        assert_eq!(installed_app_id(r"C:\src\xdev\target\debug", id), None);
        assert_eq!(installed_app_id(r"C:\src\xdev\target\release", id), None);
        assert_eq!(
            installed_app_id(r"C:\Users\a\AppData\Local\xDev", id),
            Some(id)
        );
        assert_eq!(
            installed_app_id(r"C:\Program Files\xDev\target", id),
            Some(id)
        );
    }

    #[test]
    fn tags_are_16_hex_and_differ_by_run_and_id() {
        assert_eq!(tag(0xabcd, 1), "0000abcd00000001");
        assert_eq!(tag(u32::MAX, -1), "ffffffffffffffff");
        assert_ne!(tag(1, 2), tag(2, 2));
        assert_ne!(tag(1, 2), tag(1, 3));
    }

    #[test]
    fn toast_xml_carries_title_and_body() {
        assert_eq!(
            toast_xml("Claude", "Waiting for you"),
            "<toast duration=\"short\"><visual><binding template=\"ToastGeneric\">\
             <text id=\"1\">Claude</text><text id=\"2\">Waiting for you</text>\
             </binding></visual><audio silent=\"true\"/></toast>"
        );
    }

    #[test]
    fn escape_keeps_markup_out() {
        assert_eq!(
            escape(r#"<a href="x">&'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;"
        );
        assert!(toast_xml("</text><text>", "b").contains("&lt;/text&gt;&lt;text&gt;"));
    }

    #[test]
    fn escape_drops_what_xml_cannot_carry() {
        assert_eq!(escape("a\u{1b}[1mb\u{0}\u{ffff}"), "a[1mb");
        assert_eq!(escape("tab\tline\r\nend é"), "tab\tline\r\nend é");
    }
}
