//! The macOS keyboard input source, for the "Option as Alt" auto mode.

/// The current macOS keyboard input source id ("com.apple.keylayout.US"); `None` elsewhere or on failure.
#[tauri::command]
pub async fn keyboard_input_source(app: tauri::AppHandle) -> Option<String> {
    input_source(&app).await
}

/// Off macOS there is no input source to read; nothing is touched.
#[cfg(not(target_os = "macos"))]
async fn input_source(_app: &tauri::AppHandle) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
async fn input_source(app: &tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;

    // The TIS calls assert the main queue on recent macOS, so they run there.
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(xdev_input_source::current_input_source_id());
    })
    .ok()?;
    tauri::async_runtime::spawn_blocking(move || wait_for_source(&rx, MAIN_THREAD_WAIT))
        .await
        .ok()?
}

/// How long the main thread gets to answer before the layout is reported as unknown.
#[cfg(any(target_os = "macos", test))]
const MAIN_THREAD_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// The id the main thread sent, or `None` when it sent nothing in time or sent `None`.
#[cfg(any(target_os = "macos", test))]
fn wait_for_source(
    rx: &std::sync::mpsc::Receiver<Option<String>>,
    wait: std::time::Duration,
) -> Option<String> {
    rx.recv_timeout(wait).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn the_sent_id_comes_back() {
        let (tx, rx) = mpsc::channel();
        tx.send(Some("com.apple.keylayout.US".to_string())).unwrap();
        assert_eq!(
            wait_for_source(&rx, MAIN_THREAD_WAIT).as_deref(),
            Some("com.apple.keylayout.US")
        );
    }

    #[test]
    fn an_empty_answer_is_none() {
        let (tx, rx) = mpsc::channel();
        tx.send(None).unwrap();
        assert_eq!(wait_for_source(&rx, MAIN_THREAD_WAIT), None);
    }

    #[test]
    fn a_main_thread_that_never_answers_gives_none_instead_of_blocking() {
        let (_tx, rx) = mpsc::channel::<Option<String>>();
        assert_eq!(wait_for_source(&rx, Duration::from_millis(20)), None);
    }

    #[test]
    fn a_dropped_sender_gives_none() {
        let (tx, rx) = mpsc::channel::<Option<String>>();
        drop(tx);
        assert_eq!(wait_for_source(&rx, MAIN_THREAD_WAIT), None);
    }

    #[test]
    fn the_wait_is_two_seconds() {
        assert_eq!(MAIN_THREAD_WAIT, Duration::from_secs(2));
    }
}
