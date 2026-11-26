use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::webview::{Cookie, NewWindowResponse};
use tauri::window::Color;
use tauri::{
    AppHandle, DragDropEvent, Emitter, LogicalPosition, LogicalSize, Manager, Monitor,
    PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use url::Url;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
mod smooth_drag {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVE, WM_MOVING, WM_NCDESTROY,
    };

    const SUBCLASS_ID: usize = 0x5355_4D01;

    struct DragThrottle {
        in_size_move: AtomicBool,
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid: usize,
        ref_data: usize,
    ) -> LRESULT {
        let state = &*(ref_data as *const DragThrottle);
        match msg {
            WM_ENTERSIZEMOVE => {
                state.in_size_move.store(true, Ordering::Relaxed);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            WM_MOVING if state.in_size_move.load(Ordering::Relaxed) => 1,
            WM_MOVE if state.in_size_move.load(Ordering::Relaxed) => 0,
            WM_EXITSIZEMOVE => {
                state.in_size_move.store(false, Ordering::Relaxed);
                let res = DefSubclassProc(hwnd, msg, wparam, lparam);
                // Notify WebView2 once after drag finishes so popups and IME stay aligned.
                let _ = DefSubclassProc(hwnd, WM_MOVE, 0, 0);
                res
            }
            WM_NCDESTROY => {
                let res = DefSubclassProc(hwnd, msg, wparam, lparam);
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                drop(Box::from_raw(ref_data as *mut DragThrottle));
                res
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    pub fn attach(win: &tauri::WebviewWindow) {
        let win_clone = win.clone();
        let _ = win.run_on_main_thread(move || {
            if let Ok(hwnd) = win_clone.hwnd() {
                let raw_hwnd = hwnd.0 as HWND;
                let data = Box::into_raw(Box::new(DragThrottle {
                    in_size_move: AtomicBool::new(false),
                })) as usize;
                unsafe {
                    if SetWindowSubclass(raw_hwnd, Some(subclass_proc), SUBCLASS_ID, data) == 0 {
                        drop(Box::from_raw(data as *mut DragThrottle));
                    }
                }
            }
        });
    }
}

const BRIDGE_JS: &str = include_str!("../../bridge.js");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseMeta {
    version: String,
    build_number: u64,
    github_repository: String,
    update_path: String,
    update_mode: String,
}

impl Default for ReleaseMeta {
    fn default() -> Self {
        let update_path = if cfg!(target_os = "macos") {
            "/api/releases/macos/arm64-tauri/".to_string()
        } else {
            "/api/releases/windows/x64-tauri/".to_string()
        };
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_number: 0,
            github_repository: "buyun00/Summon-Bot".to_string(),
            update_path,
            update_mode: if cfg!(target_os = "macos") {
                "manual".to_string()
            } else {
                "automatic".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootState {
    status: String,
    percent: u8,
    stage: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    status: String,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalConnection {
    origin: String,
    #[allow(dead_code)]
    data_root: String,
    access_token: String,
    cookie_name: String,
    cookie_value: String,
    secure: bool,
    needs_intro: bool,
    onboarding_stage: String,
}

#[derive(Debug, Clone, Copy)]
struct RectPx {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperEvent {
    event: String,
    stage: Option<String>,
    message: Option<String>,
    origin: Option<String>,
    data_root: Option<String>,
    access_token: Option<String>,
    cookie_name: Option<String>,
    cookie_value: Option<String>,
    secure: Option<bool>,
    needs_intro: Option<bool>,
    onboarding_stage: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestReleaseManifest {
    version: String,
    build_number: u64,
    download_url: Option<String>,
    main_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropFileMeta {
    drop_id: String,
    path: String,
    name: String,
    size: u64,
    mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDropPayload {
    files: Vec<NativeDropFileMeta>,
    x: f64,
    y: f64,
}

struct AppState {
    release: ReleaseMeta,
    is_packaged: bool,
    from_installer: bool,
    installer_handed_off: AtomicBool,
    booting: AtomicBool,
    checking_update: AtomicBool,
    boot_state: Mutex<BootState>,
    update_state: Mutex<UpdateState>,
    downloaded_installer: Mutex<Option<PathBuf>>,
    connection: Mutex<Option<LocalConnection>>,
    intro_done_tx: Mutex<Option<oneshot::Sender<()>>>,
    intro_bounds: Mutex<Option<RectPx>>,
    morph_seq: AtomicU64,
    drop_seq: AtomicU64,
    dropped_files: Mutex<HashMap<String, PathBuf>>,
    last_maximized: AtomicBool,
}

fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn node_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn profile_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Relay");
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            return PathBuf::from(home)
                .join("AppData")
                .join("Roaming")
                .join("Relay");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Relay");
        }
    }
    std::env::temp_dir().join("Relay")
}

fn resolve_local_data_root_sync(profile: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let formal = PathBuf::from("D:/Relay-Bot-data");
        if formal.join("config").join("deployment.json").exists() {
            return formal;
        }
    }
    profile.join("data")
}

fn is_fresh_install_sync(profile: &Path) -> bool {
    let data_root = resolve_local_data_root_sync(profile);
    let model_path = data_root.join("config").join("model-connections.json");
    let Ok(raw) = std::fs::read_to_string(&model_path) else {
        return true;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    val.get("activeId")
        .and_then(|v| v.as_str())
        .map(|s| s.is_empty())
        .unwrap_or(true)
}

fn resolve_runtime_paths(app: &AppHandle) -> (PathBuf, PathBuf, PathBuf, bool) {
    let node_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    if let Ok(res_dir) = app.path().resource_dir() {
        let candidates = [
            res_dir.join("summon-runtime"),
            res_dir.join("resources").join("summon-runtime"),
        ];
        for runtime in candidates {
            if runtime.join("scripts/installation/desktop.mjs").exists() {
                let node_bin = runtime.join("runtime").join(node_name);
                let helper = runtime.join("tauri-boot-helper.mjs");
                if node_bin.exists() && helper.exists() {
                    return (runtime, node_bin, helper, true);
                }
            }
        }
    }

    // Development fallback: repo root (parent of desktop-tauri)
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let helper = dev_root.join("desktop-tauri").join("boot-helper.mjs");

    // On Windows dev, prefer the installed Node 24.21.0 runtime from D:/Relay-Bot-app if present
    let mut node_bin = PathBuf::from(node_name);
    #[cfg(target_os = "windows")]
    {
        if let Ok(cur_raw) = std::fs::read_to_string("D:/Relay-Bot-app/current.json") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&cur_raw) {
                if let Some(rel_root) = val.get("releaseRoot").and_then(|v| v.as_str()) {
                    let candidate = PathBuf::from(rel_root).join("runtime").join("node.exe");
                    if candidate.exists() {
                        node_bin = candidate;
                    }
                }
            }
        }
    }

    (dev_root, node_bin, helper, false)
}

fn load_release_meta(app: &AppHandle) -> (ReleaseMeta, bool) {
    if let Ok(res_dir) = app.path().resource_dir() {
        for candidate in [
            res_dir.join("release.json"),
            res_dir.join("resources").join("release.json"),
            res_dir.join("summon-runtime").join("tauri-release.json"),
        ] {
            if let Ok(raw) = std::fs::read_to_string(&candidate) {
                if let Ok(meta) = serde_json::from_str::<ReleaseMeta>(&raw) {
                    return (meta, true);
                }
            }
        }
    }

    let dev_release = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("release.json"));
    let mut meta = ReleaseMeta::default();
    if let Some(path) = dev_release {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(v) = val.get("version").and_then(|x| x.as_str()) {
                    meta.version = v.to_string();
                }
                if let Some(b) = val.get("buildNumber").and_then(|x| x.as_u64()) {
                    meta.build_number = b;
                }
                if let Some(r) = val.get("githubRepository").and_then(|x| x.as_str()) {
                    meta.github_repository = r.to_string();
                }
            }
        }
    }
    (meta, false)
}

fn url_origin(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    match parsed.port() {
        Some(port) => Some(format!("{scheme}://{host}:{port}")),
        None => Some(format!("{scheme}://{host}")),
    }
}

fn is_web_origin(state: &AppState, raw: &str) -> bool {
    let conn = state.connection.lock().unwrap();
    let Some(conn) = conn.as_ref() else {
        return false;
    };
    url_origin(raw).as_deref() == Some(conn.origin.as_str())
}

fn verify_sender(
    window: &WebviewWindow,
    state: &AppState,
    allow_boot: bool,
    allow_main: bool,
) -> Result<(), String> {
    let label = window.label();
    if allow_boot && label == "intro" {
        return Ok(());
    }
    if allow_main && label == "main" {
        let current = window
            .url()
            .map_err(|_| "Untrusted desktop request".to_string())?;
        if is_web_origin(state, current.as_str()) && current.path() == "/" {
            return Ok(());
        }
    }
    Err("Untrusted desktop request".to_string())
}

fn stage_progress(stage: &str) -> (u8, &'static str) {
    match stage {
        "extract" => (64, "正在准备核心运行组件…"),
        "prepare" => (74, "正在准备本机环境…"),
        "upgrade" => (78, "正在平滑升级本机运行时…"),
        "gateway" => (84, "正在启动核心服务…"),
        "web" => (92, "正在启动本机工作台…"),
        "connect" => (97, "正在唤醒 Summon Bot…"),
        _ => (74, "正在准备本机环境…"),
    }
}

fn signal_installer_handoff(state: &AppState) {
    if !state.from_installer {
        return;
    }
    if state.installer_handed_off.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = std::env::temp_dir().join("summon-installer-handoff.ready");
    let _ = std::fs::write(path, "ready");
}

fn broadcast_boot_state(app: &AppHandle, state: &AppState, next: BootState) {
    {
        let mut guard = state.boot_state.lock().unwrap();
        *guard = next.clone();
    }
    if let Some(win) = app.get_webview_window("intro") {
        let _ = win.emit("summon:boot-state", next);
    }
}

fn broadcast_update_state(app: &AppHandle, state: &AppState, next: UpdateState) {
    {
        let mut guard = state.update_state.lock().unwrap();
        *guard = next.clone();
    }
    for label in ["main", "intro"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.emit("summon:update-state", next.clone());
        }
    }
}

fn update_feeds(release: &ReleaseMeta) -> (String, String) {
    let local = format!("http://127.0.0.1:8787{}", release.update_path);
    let parts: Vec<&str> = release
        .update_path
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let (platform, arch) = if parts.len() >= 2 {
        (parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        (
            if cfg!(target_os = "macos") {
                "macos"
            } else {
                "windows"
            },
            if cfg!(target_os = "macos") {
                "arm64-tauri"
            } else {
                "x64-tauri"
            },
        )
    };
    let remote = format!(
        "https://github.com/{}/releases/download/client-{}-{}/",
        release.github_repository, platform, arch
    );
    (local, remote)
}

fn monitor_work_area(monitor: &Monitor) -> RectPx {
    let area = monitor.work_area();
    RectPx {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
        scale: monitor.scale_factor(),
    }
}

fn monitor_full_bounds(monitor: &Monitor) -> RectPx {
    let pos = monitor.position();
    let size = monitor.size();
    RectPx {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        scale: monitor.scale_factor(),
    }
}

fn target_monitor_for_main(app: &AppHandle) -> Option<Monitor> {
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(Some(m)) = main.current_monitor() {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

fn compute_stage_bounds_logical(stage: &str, work_area: RectPx) -> (f64, f64, f64, f64) {
    let scale = work_area.scale.max(1.0);
    let area_x = work_area.x as f64 / scale;
    let area_y = work_area.y as f64 / scale;
    let area_w = work_area.width as f64 / scale;
    let area_h = work_area.height as f64 / scale;

    let (width, height) = match stage {
        "main" => (
            1280.0_f64.min(840.0_f64.max(area_w - 64.0)),
            900.0_f64.min(620.0_f64.max(area_h - 64.0)),
        ),
        "bot" => (
            780.0_f64.min(480.0_f64.max(area_w - 40.0)),
            740.0_f64.min(560.0_f64.max(area_h - 40.0)),
        ),
        _ => (
            620.0_f64.min(480.0_f64.max(area_w - 40.0)),
            700.0_f64.min(560.0_f64.max(area_h - 40.0)),
        ),
    };
    let x = (area_x + (area_w - width) / 2.0).round();
    let y = (area_y + (area_h - height) / 2.0).round();
    (x, y, width.round(), height.round())
}

fn default_dark_mode() -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .creation_flags(0x08000000)
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("0x0") {
                return true;
            }
        }
    }
    false
}

fn theme_bg_color(dark: bool) -> Color {
    if dark {
        Color(0x0b, 0x0c, 0x10, 0xff)
    } else {
        Color(0xf8, 0xf6, 0xf1, 0xff)
    }
}

fn create_or_show_intro_window(app: &AppHandle, from_installer_param: bool) -> Result<WebviewWindow, String> {
    let state = app.state::<AppState>();
    let monitor = target_monitor_for_main(app);
    let bounds = monitor.as_ref().map(monitor_full_bounds).unwrap_or(RectPx {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        scale: 1.0,
    });
    *state.intro_bounds.lock().unwrap() = Some(bounds);

    // Match Electron Windows DWM transparent frameless fullscreen workaround (+1px height)
    let win_height = if cfg!(target_os = "windows") {
        bounds.height + 1
    } else {
        bounds.height
    };

    if let Some(existing) = app.get_webview_window("intro") {
        let _ = existing.set_position(Position::Physical(PhysicalPosition::new(bounds.x, bounds.y)));
        let _ = existing.set_size(Size::Physical(PhysicalSize::new(bounds.width, win_height)));
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let defer_reveal = state.from_installer && !state.installer_handed_off.load(Ordering::SeqCst);
    let url = WebviewUrl::App(
        format!(
            "index.html?from_installer={}",
            if from_installer_param { "1" } else { "0" }
        )
        .into(),
    );

    let builder = WebviewWindowBuilder::new(app, "intro", url)
        .title("Summon Bot")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .visible(false)
        .initialization_script(format!("window.__SUMMON_TAURI_WINDOW__ = 'intro';\n{BRIDGE_JS}"));

    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(bounds.x, bounds.y)));
    let _ = win.set_size(Size::Physical(PhysicalSize::new(bounds.width, win_height)));
    if !defer_reveal {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(win)
}

fn reveal_intro_and_handoff(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(win) = app.get_webview_window("intro") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    if state.from_installer && !state.installer_handed_off.load(Ordering::SeqCst) {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            let st = app_clone.state::<AppState>();
            signal_installer_handoff(&st);
        });
    }
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt") | Some("md") | Some("log") => "text/plain",
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") | Some("cjs") => "text/javascript",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn create_main_window(
    app: &AppHandle,
    show_immediately: bool,
    initial_bounds: (f64, f64, f64, f64),
) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window("main") {
        let (x, y, w, h) = initial_bounds;
        let _ = existing.set_position(Position::Logical(LogicalPosition::new(x, y)));
        let _ = existing.set_size(Size::Logical(LogicalSize::new(w, h)));
        if show_immediately {
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
        }
        return Ok(existing);
    }

    let dark = default_dark_mode();
    let (x, y, w, h) = initial_bounds;

    let app_for_nav = app.clone();
    let app_for_new = app.clone();

    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(Url::parse("about:blank").unwrap()),
    )
    .title("Summon Bot")
    .position(x, y)
    .inner_size(w, h)
    .min_inner_size(440.0, 560.0)
    .visible(false)
    .resizable(true)
    .shadow(true)
    .background_color(theme_bg_color(dark))
    .initialization_script(format!("window.__SUMMON_TAURI_WINDOW__ = 'main';\n{BRIDGE_JS}"))
    .on_navigation(move |target_url| {
        let raw = target_url.as_str();
        if raw == "about:blank" {
            return true;
        }
        let st = app_for_nav.state::<AppState>();
        if is_web_origin(&st, raw) {
            return true;
        }
        if raw.starts_with("http://") || raw.starts_with("https://") {
            let _ = app_for_nav.opener().open_url(raw, None::<&str>);
        }
        false
    })
    .on_new_window(move |target_url, features| {
        let raw = target_url.as_str();
        if raw.starts_with("http://") || raw.starts_with("https://") {
            let st = app_for_new.state::<AppState>();
            if is_web_origin(&st, raw) {
                let child_label = format!(
                    "popup-{}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                );
                let mut child_builder = WebviewWindowBuilder::new(
                    &app_for_new,
                    child_label,
                    WebviewUrl::External(target_url.clone()),
                )
                .title("Summon Bot")
                .inner_size(1120.0, 800.0)
                .min_inner_size(420.0, 420.0)
                .window_features(features);
                child_builder = child_builder.background_color(theme_bg_color(default_dark_mode()));
                if let Ok(popup) = child_builder.build() {
                    let _ = popup.show();
                    return NewWindowResponse::Create { window: popup };
                }
            } else {
                let _ = app_for_new.opener().open_url(raw, None::<&str>);
            }
        }
        NewWindowResponse::Deny
    });

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(16.0, 16.0));
    }

    let win = builder.build().map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    smooth_drag::attach(&win);

    let app_for_events = app.clone();
    let win_for_events = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Focused(active) => {
            let _ = win_for_events.emit("summon:window-active", *active);
        }
        WindowEvent::Resized(_) => {
            if let Ok(maximized) = win_for_events.is_maximized() {
                let st = app_for_events.state::<AppState>();
                let prev = st.last_maximized.swap(maximized, Ordering::SeqCst);
                if prev != maximized {
                    let _ = win_for_events.emit("summon:window-maximized", maximized);
                }
            }
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
            let st = app_for_events.state::<AppState>();
            let mut dropped_meta = Vec::new();
            let mut map = st.dropped_files.lock().unwrap();
            if map.len() > 200 {
                map.clear();
            }
            for path in paths {
                let Ok(meta) = std::fs::metadata(path) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string();
                let seq = st.drop_seq.fetch_add(1, Ordering::SeqCst);
                let drop_id = format!("drop-{seq}");
                map.insert(drop_id.clone(), path.clone());
                dropped_meta.push(NativeDropFileMeta {
                    drop_id,
                    path: path.to_string_lossy().to_string(),
                    name,
                    size: meta.len(),
                    mime: guess_mime(path).to_string(),
                });
            }
            drop(map);
            if !dropped_meta.is_empty() {
                let scale = win_for_events.scale_factor().unwrap_or(1.0);
                let payload = NativeDropPayload {
                    files: dropped_meta,
                    x: position.x / scale,
                    y: position.y / scale,
                };
                let _ = win_for_events.emit("summon:native-file-drop", payload);
            }
        }
        _ => {}
    });

    Ok(win)
}

fn inject_session_cookie(win: &WebviewWindow, conn: &LocalConnection) {
    let Ok(parsed) = Url::parse(&conn.origin) else {
        return;
    };
    let Some(host) = parsed.host_str() else {
        return;
    };
    let mut cookie = Cookie::new(conn.cookie_name.clone(), conn.cookie_value.clone());
    cookie.set_domain(host.to_string());
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_secure(conn.secure);
    let _ = win.set_cookie(cookie);
}

async fn run_boot_helper(
    app: &AppHandle,
    profile: &Path,
    on_stage: impl Fn(&str),
) -> Result<LocalConnection, String> {
    let (runtime_root, node_bin, helper_path, _) = resolve_runtime_paths(app);
    let mut cmd = tokio::process::Command::new(&node_bin);
    cmd.arg(&helper_path)
        .arg("--runtime")
        .arg(&runtime_root)
        .arg("--profile")
        .arg(profile)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动本机运行环境：{e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取本机启动输出".to_string())?;
    let stderr = child.stderr.take();

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                if buf.len() < 800 {
                    buf.push_str(&line);
                }
                line.clear();
            }
        }
        buf
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut ready_conn: Option<LocalConnection> = None;
    let mut last_error: Option<String> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<HelperEvent>(trimmed) else {
            continue;
        };
        match ev.event.as_str() {
            "progress" => {
                if let Some(stage) = ev.stage.as_deref() {
                    on_stage(stage);
                }
            }
            "ready" => {
                ready_conn = Some(LocalConnection {
                    origin: ev.origin.unwrap_or_else(|| "http://127.0.0.1:8787".into()),
                    data_root: ev.data_root.unwrap_or_default(),
                    access_token: ev.access_token.unwrap_or_default(),
                    cookie_name: ev
                        .cookie_name
                        .unwrap_or_else(|| "summon_local_session".into()),
                    cookie_value: ev.cookie_value.unwrap_or_default(),
                    secure: ev.secure.unwrap_or(false),
                    needs_intro: ev.needs_intro.unwrap_or(false),
                    onboarding_stage: ev.onboarding_stage.unwrap_or_else(|| "main".into()),
                });
                break;
            }
            "error" => {
                last_error = ev.message;
                break;
            }
            _ => {}
        }
    }

    if let Some(conn) = ready_conn {
        let _ = child.start_kill();
        return Ok(conn);
    }

    let status = child.wait().await.ok();
    let err_out = stderr_task.await.unwrap_or_default();

    if let Some(msg) = last_error {
        Err(msg)
    } else {
        let code = status.and_then(|s| s.code()).unwrap_or(-1);
        let detail = err_out.trim();
        if detail.is_empty() {
            Err(format!("本机服务启动失败（exit {code}）"))
        } else {
            Err(detail.chars().take(200).collect())
        }
    }
}

fn spawn_boot_local_instance(app: AppHandle, retry_count: u8) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if state.booting.swap(true, Ordering::SeqCst) {
            return;
        }

        let profile = profile_root();
        let fresh = is_fresh_install_sync(&profile);
        let show_splash_now = state.from_installer || fresh || retry_count > 0;
        let from_installer_param = state.from_installer && retry_count == 0;

        let init_percent = if from_installer_param { 54 } else { 14 };
        let init_stage = if state.from_installer {
            stage_progress("extract").1
        } else {
            stage_progress("prepare").1
        };
        broadcast_boot_state(
            &app,
            &state,
            BootState {
                status: "booting".into(),
                percent: init_percent,
                stage: init_stage.into(),
                error: String::new(),
            },
        );

        let cancel_delayed = ArcFlag::new();
        if show_splash_now {
            let _ = create_or_show_intro_window(&app, from_installer_param);
            if state.from_installer && !state.installer_handed_off.load(Ordering::SeqCst) {
                let app_fb = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(900)).await;
                    reveal_intro_and_handoff(&app_fb);
                });
            }
        } else {
            let app_delay = app.clone();
            let flag_delay = cancel_delayed.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(450)).await;
                if !flag_delay.is_set() {
                    let _ = create_or_show_intro_window(&app_delay, false);
                }
            });
        }

        let app_prog = app.clone();
        let result = run_boot_helper(&app, &profile, move |stage| {
            let (pct, text) = stage_progress(stage);
            if app_prog.get_webview_window("intro").is_some() {
                let st = app_prog.state::<AppState>();
                broadcast_boot_state(
                    &app_prog,
                    &st,
                    BootState {
                        status: "booting".into(),
                        percent: pct,
                        stage: text.into(),
                        error: String::new(),
                    },
                );
            }
        })
        .await;

        cancel_delayed.set();

        let mut should_retry = false;
        match result {
            Ok(conn) => {
                *state.connection.lock().unwrap() = Some(conn.clone());

                let work_area = target_monitor_for_main(&app)
                    .as_ref()
                    .map(monitor_work_area)
                    .unwrap_or(RectPx {
                        x: 0,
                        y: 0,
                        width: 1440,
                        height: 900,
                        scale: 1.0,
                    });

                let initial_stage = if conn.needs_intro {
                    conn.onboarding_stage.as_str()
                } else {
                    "main"
                };
                let initial_bounds = compute_stage_bounds_logical(initial_stage, work_area);
                let initial_url_str = if conn.needs_intro {
                    format!("{}/?onboarding_window={}", conn.origin, initial_stage)
                } else {
                    format!("{}/", conn.origin)
                };

                let has_intro_open = app.get_webview_window("intro").is_some();
                let should_unbox = conn.needs_intro || (state.from_installer && has_intro_open);

                match create_main_window(&app, !should_unbox, initial_bounds) {
                    Ok(main_win) => {
                        inject_session_cookie(&main_win, &conn);
                        if let Ok(url) = Url::parse(&initial_url_str) {
                            let _ = main_win.navigate(url);
                        }

                        if should_unbox {
                            let _ = create_or_show_intro_window(&app, from_installer_param);
                            reveal_intro_and_handoff(&app);
                            let (tx, rx) = oneshot::channel::<()>();
                            *state.intro_done_tx.lock().unwrap() = Some(tx);

                            broadcast_boot_state(
                                &app,
                                &state,
                                BootState {
                                    status: "ready_to_unbox".into(),
                                    percent: 100,
                                    stage: "准备就绪，开箱！".into(),
                                    error: String::new(),
                                },
                            );

                            let _ = tokio::time::timeout(Duration::from_millis(3800), rx).await;
                            tokio::time::sleep(Duration::from_millis(60)).await;
                            let (x, y, w, h) = initial_bounds;
                            let _ = main_win.set_position(Position::Logical(LogicalPosition::new(x, y)));
                            let _ = main_win.set_size(Size::Logical(LogicalSize::new(w, h)));
                            let _ = main_win.show();
                            let _ = main_win.set_focus();

                            if let Some(intro) = app.get_webview_window("intro") {
                                tokio::time::sleep(Duration::from_millis(160)).await;
                                let _ = intro.close();
                            }
                        } else {
                            signal_installer_handoff(&state);
                            tokio::time::sleep(Duration::from_millis(180)).await;
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                            if let Some(intro) = app.get_webview_window("intro") {
                                let _ = intro.close();
                            }
                        }
                    }
                    Err(win_err) => {
                        eprintln!("[summon-tauri] failed to create main window: {win_err}");
                        signal_installer_handoff(&state);
                        let _ = create_or_show_intro_window(&app, false);
                        broadcast_boot_state(
                            &app,
                            &state,
                            BootState {
                                status: "error".into(),
                                percent: 90,
                                stage: format!("无法打开工作台窗口：{win_err}"),
                                error: String::new(),
                            },
                        );
                    }
                }
            }
            Err(err_msg) => {
                eprintln!("[summon-tauri] boot helper error: {err_msg}");
                signal_installer_handoff(&state);
                let _ = create_or_show_intro_window(&app, false);
                if retry_count < 2 {
                    should_retry = true;
                    let cur_pct = state.boot_state.lock().unwrap().percent.max(70);
                    broadcast_boot_state(
                        &app,
                        &state,
                        BootState {
                            status: "booting".into(),
                            percent: cur_pct,
                            stage: "核心服务启动较慢，正在自动重试…".into(),
                            error: String::new(),
                        },
                    );
                } else {
                    broadcast_boot_state(
                        &app,
                        &state,
                        BootState {
                            status: "error".into(),
                            percent: 70,
                            stage: format!("本机服务暂时未能就绪：{err_msg}"),
                            error: String::new(),
                        },
                    );
                }
            }
        }

        *state.intro_done_tx.lock().unwrap() = None;
        state.booting.store(false, Ordering::SeqCst);

        if should_retry {
            tokio::time::sleep(Duration::from_millis(1800)).await;
            spawn_boot_local_instance(app, retry_count + 1);
        }
    });
}

#[derive(Clone)]
struct ArcFlag(std::sync::Arc<AtomicBool>);
impl ArcFlag {
    fn new() -> Self {
        Self(std::sync::Arc::new(AtomicBool::new(false)))
    }
    fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

async fn perform_check_update(app: &AppHandle, force: bool) -> UpdateState {
    let state = app.state::<AppState>();
    {
        let current = state.update_state.lock().unwrap().clone();
        if current.status == "downloading" || (!force && current.status == "downloaded") {
            return current;
        }
        if !state.is_packaged {
            return current;
        }
    }
    if state.checking_update.swap(true, Ordering::SeqCst) {
        return state.update_state.lock().unwrap().clone();
    }

    let current_version = state.release.version.clone();
    broadcast_update_state(
        app,
        &state,
        UpdateState {
            status: "checking".into(),
            current_version: current_version.clone(),
            version: None,
            percent: Some(0),
            message: Some(String::new()),
            download_url: None,
        },
    );

    let (local_feed, remote_feed) = update_feeds(&state.release);
    let client = reqwest::Client::builder()
        .user_agent("Summon-Bot-Tauri")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut found: Option<(String, LatestReleaseManifest)> = None;
    let mut unpublished = false;
    let mut last_err = String::new();

    for (idx, feed) in [&local_feed, &remote_feed].iter().enumerate() {
        let timeout = if idx == 0 {
            Duration::from_millis(1200)
        } else {
            Duration::from_secs(15)
        };
        let manifest_url = format!("{feed}latest.json");
        match client
            .get(&manifest_url)
            .header("Cache-Control", "no-store")
            .timeout(timeout)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().as_u16() == 404 && idx == 1 {
                    unpublished = true;
                    break;
                }
                if !resp.status().is_success() {
                    last_err = format!("Update unavailable (HTTP {})", resp.status().as_u16());
                    continue;
                }
                match resp.json::<LatestReleaseManifest>().await {
                    Ok(manifest) => {
                        found = Some(((*feed).clone(), manifest));
                        break;
                    }
                    Err(e) => {
                        last_err = e.to_string();
                    }
                }
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    let final_state = if let Some((feed, manifest)) = found {
        if manifest.build_number <= state.release.build_number {
            UpdateState {
                status: "current".into(),
                current_version: current_version.clone(),
                version: Some(manifest.version),
                percent: None,
                message: Some(String::new()),
                download_url: None,
            }
        } else {
            let base_url = Url::parse(&feed).ok();
            let raw_dl = manifest
                .download_url
                .or(manifest.main_file)
                .unwrap_or_default();
            let resolved_dl = base_url
                .and_then(|b| b.join(&raw_dl).ok())
                .map(|u| u.to_string())
                .unwrap_or_default();

            if !resolved_dl.starts_with(&feed) {
                UpdateState {
                    status: "error".into(),
                    current_version: current_version.clone(),
                    version: None,
                    percent: None,
                    message: Some("Invalid client download URL".into()),
                    download_url: None,
                }
            } else if state.release.update_mode == "manual" {
                UpdateState {
                    status: "manual".into(),
                    current_version: current_version.clone(),
                    version: Some(manifest.version),
                    percent: None,
                    message: None,
                    download_url: Some(resolved_dl),
                }
            } else {
                // Automatic Windows NSIS update download
                broadcast_update_state(
                    app,
                    &state,
                    UpdateState {
                        status: "downloading".into(),
                        current_version: current_version.clone(),
                        version: Some(manifest.version.clone()),
                        percent: Some(0),
                        message: None,
                        download_url: Some(resolved_dl.clone()),
                    },
                );
                match download_update_installer(app, &client, &resolved_dl, &manifest.version).await
                {
                    Ok(path) => {
                        *state.downloaded_installer.lock().unwrap() = Some(path);
                        UpdateState {
                            status: "downloaded".into(),
                            current_version: current_version.clone(),
                            version: Some(manifest.version),
                            percent: Some(100),
                            message: None,
                            download_url: Some(resolved_dl),
                        }
                    }
                    Err(e) => UpdateState {
                        status: "error".into(),
                        current_version: current_version.clone(),
                        version: None,
                        percent: None,
                        message: Some(e),
                        download_url: None,
                    },
                }
            }
        }
    } else if unpublished {
        UpdateState {
            status: "unpublished".into(),
            current_version: current_version.clone(),
            version: None,
            percent: None,
            message: None,
            download_url: None,
        }
    } else {
        UpdateState {
            status: "error".into(),
            current_version: current_version.clone(),
            version: None,
            percent: None,
            message: Some(last_err),
            download_url: None,
        }
    };

    state.checking_update.store(false, Ordering::SeqCst);
    broadcast_update_state(app, &state, final_state.clone());
    final_state
}

async fn download_update_installer(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    version: &str,
) -> Result<PathBuf, String> {
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下载更新失败（HTTP {}）", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let dir = std::env::temp_dir().join("summon-tauri-update");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let file_path = dir.join(format!("Summon-Bot-{version}-tauri-setup.exe"));
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_pct: u8 = 0;
    let state = app.state::<AppState>();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| e.to_string())?;
        file.write_all(&data).await.map_err(|e| e.to_string())?;
        received += data.len() as u64;
        if total > 0 {
            let pct = ((received * 100) / total).min(99) as u8;
            if pct != last_pct {
                last_pct = pct;
                broadcast_update_state(
                    app,
                    &state,
                    UpdateState {
                        status: "downloading".into(),
                        current_version: state.release.version.clone(),
                        version: Some(version.to_string()),
                        percent: Some(pct),
                        message: None,
                        download_url: Some(url.to_string()),
                    },
                );
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(file_path)
}

fn open_manual_update_download(app: &AppHandle, state: &AppState) -> bool {
    let cur = state.update_state.lock().unwrap().clone();
    if cur.status != "manual" {
        return false;
    }
    let Some(dl) = cur.download_url else {
        return false;
    };
    let (local_feed, remote_feed) = update_feeds(&state.release);
    if !dl.starts_with(&local_feed) && !dl.starts_with(&remote_feed) {
        return false;
    }
    app.opener().open_url(&dl, None::<&str>).is_ok()
}

fn launch_downloaded_installer_and_quit(app: &AppHandle, state: &AppState) -> bool {
    let path = state.downloaded_installer.lock().unwrap().clone();
    let Some(installer) = path else {
        return false;
    };
    if !installer.exists() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        if std::process::Command::new(&installer)
            .arg("/S")
            .spawn()
            .is_ok()
        {
            let app_exit = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(120)).await;
                app_exit.exit(0);
            });
            return true;
        }
    }
    false
}

#[tauri::command]
fn desktop_info(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    verify_sender(&window, &state, false, true)?;
    let update = state.update_state.lock().unwrap().clone();
    let is_win = cfg!(target_os = "windows");
    let is_mac = cfg!(target_os = "macos");
    Ok(serde_json::json!({
        "version": state.release.version,
        "platform": node_platform(),
        "arch": node_arch(),
        "engine": "tauri",
        "windowControlsOverlay": true,
        "customWindowControls": is_win,
        "customDragRegion": true,
        "windowControlsInsets": {
            "left": if is_mac { 80 } else { 0 },
            "right": if is_win { 146 } else { 0 }
        },
        "localInstance": true,
        "update": update
    }))
}

#[tauri::command]
fn desktop_ensure_session(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    verify_sender(&window, &state, false, true)?;
    let conn = state.connection.lock().unwrap().clone();
    let Some(conn) = conn else {
        return Ok(serde_json::json!({ "ok": false }));
    };
    inject_session_cookie(&window, &conn);
    Ok(serde_json::json!({ "ok": true, "token": conn.access_token }))
}

#[tauri::command]
fn set_theme(
    window: WebviewWindow,
    state: State<'_, AppState>,
    dark: bool,
) -> Result<bool, String> {
    verify_sender(&window, &state, false, true)?;
    let _ = window.set_background_color(Some(theme_bg_color(dark)));
    Ok(true)
}

#[tauri::command]
async fn pick_directory(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String, String> {
    verify_sender(&window, &state, false, true)?;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |folder| {
            let path = folder
                .and_then(|f| f.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = tx.send(path);
        });
    Ok(rx.await.unwrap_or_default())
}

fn is_allowed_attachment_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let rest = if let Some(after) = lower.strip_prefix("/nodes/") {
        let Some((_, tail)) = after.split_once('/') else {
            return false;
        };
        format!("/{tail}")
    } else {
        lower
    };
    if let Some(after) = rest.strip_prefix("/api/attachments/") {
        let parts: Vec<&str> = after.split('/').collect();
        return (parts.len() == 1 && !parts[0].is_empty())
            || (parts.len() == 2
                && !parts[0].is_empty()
                && (parts[1] == "preview" || parts[1] == "view"));
    }
    if let Some(after) = rest.strip_prefix("/api/files/") {
        let parts: Vec<&str> = after.split('/').collect();
        return parts.len() == 2 && !parts[0].is_empty() && parts[1] == "download";
    }
    if let Some(after) = rest.strip_prefix("/api/workspaces/") {
        let parts: Vec<&str> = after.split('/').collect();
        return parts.len() == 2 && !parts[0].is_empty() && parts[1] == "file";
    }
    false
}

fn sanitize_filename(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
async fn open_attachment(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
    name: String,
) -> Result<serde_json::Value, String> {
    verify_sender(&window, &state, false, true)?;
    let conn = state
        .connection
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "无效的文件地址".to_string())?;
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("无效的文件地址".to_string());
    }
    let base = Url::parse(&conn.origin).map_err(|_| "无效的文件地址".to_string())?;
    let target = base.join(trimmed).map_err(|_| "无效的文件地址".to_string())?;
    if url_origin(target.as_str()).as_deref() != Some(conn.origin.as_str()) {
        return Err("仅支持打开当前工作台的文件".to_string());
    }
    if !is_allowed_attachment_path(target.path()) {
        return Err("不支持打开该路径".to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(target.as_str())
        .header("Cookie", format!("{}={}", conn.cookie_name, conn.cookie_value))
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|e| format!("读取文件失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("读取文件失败（HTTP {}）", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取文件失败：{e}"))?;

    let safe_name = sanitize_filename(&name);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir()
        .join("summon-open")
        .join(format!("{:x}", stamp));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let file_path = dir.join(&safe_name);
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    let path_str = file_path.to_string_lossy().to_string();
    app.opener()
        .open_path(&path_str, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "path": path_str }))
}

async fn animate_window_to_stage(
    app: &AppHandle,
    win: &WebviewWindow,
    stage: &str,
    duration_ms: u64,
) -> bool {
    let state = app.state::<AppState>();
    let seq = state.morph_seq.fetch_add(1, Ordering::SeqCst) + 1;
    if win.is_maximized().unwrap_or(false) {
        let _ = win.unmaximize();
    }
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| target_monitor_for_main(app));
    let work_area = monitor.as_ref().map(monitor_work_area).unwrap_or(RectPx {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 1.0,
    });
    let (tx, ty, tw, th) = compute_stage_bounds_logical(stage, work_area);
    let scale = win.scale_factor().unwrap_or(work_area.scale).max(1.0);
    let cur_pos = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let cur_size = win.inner_size().unwrap_or(PhysicalSize::new(1280, 900));
    let sx = cur_pos.x as f64 / scale;
    let sy = cur_pos.y as f64 / scale;
    let sw = cur_size.width as f64 / scale;
    let sh = cur_size.height as f64 / scale;

    if (sw - tw).abs() <= 2.0
        && (sh - th).abs() <= 2.0
        && (sx - tx).abs() <= 2.0
        && (sy - ty).abs() <= 2.0
    {
        let _ = win.set_position(Position::Logical(LogicalPosition::new(tx, ty)));
        let _ = win.set_size(Size::Logical(LogicalSize::new(tw, th)));
        return true;
    }

    let ms = duration_ms.clamp(120, 800) as f64;
    let start = Instant::now();
    loop {
        if state.morph_seq.load(Ordering::SeqCst) != seq {
            return false;
        }
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let raw = (elapsed / ms).min(1.0);
        let p = 1.0 - (1.0 - raw).powi(3);
        let nx = (sx + (tx - sx) * p).round();
        let ny = (sy + (ty - sy) * p).round();
        let nw = (sw + (tw - sw) * p).round();
        let nh = (sh + (th - sh) * p).round();
        let _ = win.set_position(Position::Logical(LogicalPosition::new(nx, ny)));
        let _ = win.set_size(Size::Logical(LogicalSize::new(nw, nh)));
        if raw >= 1.0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(12)).await;
    }
}

#[tauri::command]
async fn morph_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    stage: String,
    duration: u64,
) -> Result<bool, String> {
    verify_sender(&window, &state, false, true)?;
    let target = match stage.as_str() {
        "model" | "bot" | "main" => stage.as_str(),
        _ => "main",
    };
    Ok(animate_window_to_stage(&app, &window, target, duration).await)
}

#[tauri::command]
async fn preview_desktop_intro(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    verify_sender(&window, &state, false, true)?;
    animate_window_to_stage(&app, &window, "model", 380).await;
    let _ = window.emit("summon:preview-onboarding", ());
    Ok(true)
}

#[tauri::command]
fn boot_ready(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    verify_sender(&window, &state, true, false)?;
    reveal_intro_and_handoff(&app);
    Ok(true)
}

#[tauri::command]
fn boot_intro_done(window: WebviewWindow, state: State<'_, AppState>) -> Result<bool, String> {
    verify_sender(&window, &state, true, false)?;
    if let Some(tx) = state.intro_done_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(true)
}

#[tauri::command]
fn boot_info(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    verify_sender(&window, &state, true, false)?;
    let boot = state.boot_state.lock().unwrap().clone();
    let update = state.update_state.lock().unwrap().clone();
    Ok(serde_json::json!({
        "status": boot.status,
        "percent": boot.percent,
        "stage": boot.stage,
        "error": boot.error,
        "version": state.release.version,
        "update": update
    }))
}

#[tauri::command]
async fn check_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState, String> {
    verify_sender(&window, &state, true, true)?;
    Ok(perform_check_update(&app, true).await)
}

#[tauri::command]
fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    verify_sender(&window, &state, true, true)?;
    let status = state.update_state.lock().unwrap().status.clone();
    if status == "manual" {
        return Ok(open_manual_update_download(&app, &state));
    }
    if status != "downloaded" {
        return Ok(false);
    }
    Ok(launch_downloaded_installer_and_quit(&app, &state))
}

#[tauri::command]
fn window_start_dragging(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    verify_sender(&window, &state, false, true)?;
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_minimize(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    verify_sender(&window, &state, false, true)?;
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    verify_sender(&window, &state, false, true)?;
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
    let next = window.is_maximized().unwrap_or(!maximized);
    state.last_maximized.store(next, Ordering::SeqCst);
    let _ = window.emit("summon:window-maximized", next);
    Ok(next)
}

#[tauri::command]
fn window_close(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    verify_sender(&window, &state, false, true)?;
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow, state: State<'_, AppState>) -> Result<bool, String> {
    verify_sender(&window, &state, false, true)?;
    Ok(window.is_maximized().unwrap_or(false))
}

#[tauri::command]
async fn read_dropped_file(
    window: WebviewWindow,
    state: State<'_, AppState>,
    drop_id: String,
) -> Result<Vec<u8>, String> {
    verify_sender(&window, &state, false, true)?;
    let path = state
        .dropped_files
        .lock()
        .unwrap()
        .get(&drop_id)
        .cloned()
        .ok_or_else(|| "文件授权已失效，请重新拖入".to_string())?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("无法读取文件：{e}"))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("文件超过 20 MB，请选择小一些的文件。".to_string());
    }
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("读取文件失败：{e}"))
}

fn setup_menu(app: &AppHandle, release: &ReleaseMeta) -> tauri::Result<()> {
    let check_item = MenuItemBuilder::with_id("check-update", "检查更新").build(app)?;
    let install_label = if release.update_mode == "manual" {
        "下载更新"
    } else {
        "重启并更新"
    };
    let install_item = MenuItemBuilder::with_id("install-update", install_label).build(app)?;
    let quit_item = PredefinedMenuItem::quit(app, Some("退出 Summon Bot"))?;

    let app_submenu = SubmenuBuilder::new(app, "Summon Bot")
        .item(&check_item)
        .item(&install_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        app.set_menu(menu)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = menu;
    }

    app.on_menu_event(|app, event| match event.id().as_ref() {
        "check-update" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit("summon:open-updates", ());
            } else {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = perform_check_update(&app_clone, true).await;
                });
            }
        }
        "install-update" => {
            let st = app.state::<AppState>();
            let status = st.update_state.lock().unwrap().status.clone();
            if status == "manual" {
                let _ = open_manual_update_download(app, &st);
            } else if status == "downloaded" {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("summon:request-install", ());
                } else {
                    let _ = launch_downloaded_installer_and_quit(app, &st);
                }
            }
        }
        _ => {}
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let from_installer = std::env::args().any(|arg| arg == "--from-installer");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let target = app
                .get_webview_window("intro")
                .or_else(|| app.get_webview_window("main"));
            if let Some(win) = target {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            desktop_ensure_session,
            set_theme,
            pick_directory,
            open_attachment,
            morph_window,
            preview_desktop_intro,
            boot_ready,
            boot_intro_done,
            boot_info,
            check_update,
            install_update,
            window_start_dragging,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            read_dropped_file
        ])
        .setup(move |app| {
            let handle = app.handle();
            let (release, is_packaged) = load_release_meta(handle);
            let current_version = release.version.clone();
            let init_boot = BootState {
                status: "booting".into(),
                percent: if from_installer { 56 } else { 14 },
                stage: if from_installer {
                    stage_progress("extract").1.into()
                } else {
                    stage_progress("prepare").1.into()
                },
                error: String::new(),
            };
            let init_update = UpdateState {
                status: "idle".into(),
                current_version,
                version: None,
                percent: None,
                message: None,
                download_url: None,
            };

            let _ = setup_menu(handle, &release);

            app.manage(AppState {
                release,
                is_packaged,
                from_installer,
                installer_handed_off: AtomicBool::new(false),
                booting: AtomicBool::new(false),
                checking_update: AtomicBool::new(false),
                boot_state: Mutex::new(init_boot),
                update_state: Mutex::new(init_update),
                downloaded_installer: Mutex::new(None),
                connection: Mutex::new(None),
                intro_done_tx: Mutex::new(None),
                intro_bounds: Mutex::new(None),
                morph_seq: AtomicU64::new(0),
                drop_seq: AtomicU64::new(0),
                dropped_files: Mutex::new(HashMap::new()),
                last_maximized: AtomicBool::new(false),
            });

            spawn_boot_local_instance(handle.clone(), 0);

            // Periodic background update check (15s after launch, then every 4 hours)
            let app_upd = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let _ = perform_check_update(&app_upd, false).await;
                let mut interval = tokio::time::interval(Duration::from_secs(4 * 60 * 60));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let _ = perform_check_update(&app_upd, false).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Summon Bot Tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    let st = app.state::<AppState>();
                    if st.booting.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_exit();
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    } else {
                        spawn_boot_local_instance(app.clone(), 0);
                    }
                }
            }
            _ => {}
        });
}
