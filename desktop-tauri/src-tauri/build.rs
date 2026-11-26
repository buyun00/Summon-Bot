fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_info",
            "desktop_ensure_session",
            "set_theme",
            "pick_directory",
            "open_attachment",
            "morph_window",
            "preview_desktop_intro",
            "boot_ready",
            "boot_intro_done",
            "boot_info",
            "check_update",
            "install_update",
            "window_start_dragging",
            "window_minimize",
            "window_toggle_maximize",
            "window_close",
            "window_is_maximized",
            "read_dropped_file",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
