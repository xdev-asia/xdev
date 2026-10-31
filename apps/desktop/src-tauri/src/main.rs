// Without this, release builds on Windows open an extra console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xdev_desktop::run()
}
