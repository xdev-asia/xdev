#[tauri::command]
fn app_version() -> String {
    xdev_core::version().to_string()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("failed to start xDev");
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_version_matches_core() {
        assert_eq!(super::app_version(), xdev_core::version());
    }
}
