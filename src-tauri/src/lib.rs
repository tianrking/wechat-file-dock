use chrono::Utc;
use directories::{ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

mod wechat_engine;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const STORE_FILENAME: &str = "state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountProfile {
    id: String,
    name: String,
    partition: String,
    created_at: String,
    last_used_at: String,
    color: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRules {
    document: bool,
    image: bool,
    video: bool,
    audio: bool,
    archive: bool,
    code: bool,
    app: bool,
    other: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    download_dir: String,
    auto_download: bool,
    download_rules: DownloadRules,
    organize_by_date: bool,
    launch_at_login: bool,
    notify_when_downloaded: bool,
    ui_scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRecord {
    id: String,
    account_id: String,
    account_name: String,
    filename: String,
    save_path: String,
    url: String,
    state: String,
    received_bytes: u64,
    total_bytes: u64,
    started_at: String,
    ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredState {
    accounts: Vec<AccountProfile>,
    settings: AppSettings,
    downloads: Vec<DownloadRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    accounts: Vec<AccountProfile>,
    settings: AppSettings,
    downloads: Vec<DownloadRecord>,
    wechat_preload_url: String,
    app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountPatch {
    name: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    download_dir: Option<String>,
    auto_download: Option<bool>,
    download_rules: Option<DownloadRules>,
    organize_by_date: Option<bool>,
    launch_at_login: Option<bool>,
    notify_when_downloaded: Option<bool>,
    ui_scale: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebviewTelemetryPayload {
    account_id: String,
    kind: String,
    message: Option<String>,
    details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebviewDownloadPayload {
    account_id: String,
    url: String,
    kind: String,
    filename: Option<String>,
    source_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebviewQrPayload {
    account_id: String,
    src: String,
    detected_at: String,
}

pub(crate) struct AppStore {
    state: Mutex<StoredState>,
    path: PathBuf,
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn project_dirs() -> Result<ProjectDirs, String> {
    ProjectDirs::from("dev", "wechat-file-dock", "WeChatFileDock")
        .ok_or_else(|| "Unable to resolve app data directory".to_string())
}

fn default_download_dir() -> String {
    UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("WeChatFileDock")
        .to_string_lossy()
        .to_string()
}

fn default_rules() -> DownloadRules {
    DownloadRules {
        document: true,
        image: true,
        video: true,
        audio: true,
        archive: true,
        code: true,
        app: true,
        other: true,
    }
}

fn clamp_ui_scale(value: f64) -> f64 {
    (value.clamp(0.86, 1.2) * 100.0).round() / 100.0
}

fn default_settings() -> AppSettings {
    AppSettings {
        download_dir: default_download_dir(),
        auto_download: true,
        download_rules: default_rules(),
        organize_by_date: true,
        launch_at_login: false,
        notify_when_downloaded: true,
        ui_scale: 1.0,
    }
}

fn account_name(index: usize) -> String {
    if index == 0 {
        "主微信".to_string()
    } else {
        format!("微信 {}", index + 1)
    }
}

fn create_account(name: String, index: usize) -> AccountProfile {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    AccountProfile {
        id: id.clone(),
        name: if name.trim().is_empty() { account_name(index) } else { name.trim().to_string() },
        partition: format!("persist:wfd-tauri-{id}"),
        created_at: now.clone(),
        last_used_at: now,
        color: ["#2478ff", "#19a974", "#f08c00", "#d9480f", "#7048e8", "#0ca678"][index % 6].to_string(),
        enabled: true,
    }
}

fn default_state() -> StoredState {
    StoredState {
        accounts: vec![create_account("主微信".to_string(), 0)],
        settings: default_settings(),
        downloads: Vec::new(),
    }
}

fn store_path() -> Result<PathBuf, String> {
    let dir = project_dirs()?.data_local_dir().to_path_buf();
    fs::create_dir_all(&dir).map_err(|error| format!("Unable to create state directory: {error}"))?;
    Ok(dir.join(STORE_FILENAME))
}

pub(crate) fn load_state(path: &Path) -> StoredState {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<StoredState>(&text).ok())
        .unwrap_or_else(default_state)
}

pub(crate) fn save_state(path: &Path, state: &StoredState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Unable to create state directory: {error}"))?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|error| format!("Unable to serialize state: {error}"))?;
    fs::write(path, text).map_err(|error| format!("Unable to write state: {error}"))
}

fn with_state<T>(store: &State<AppStore>, update: impl FnOnce(&mut StoredState) -> T) -> Result<T, String> {
    let mut guard = store.state.lock().map_err(|_| "State lock was poisoned".to_string())?;
    let result = update(&mut guard);
    save_state(&store.path, &guard)?;
    Ok(result)
}

fn open_with_system(target_path: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(target_path).status();

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(target_path).status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(target_path).status();

    status
        .map_err(|error| format!("Unable to open path: {error}"))
        .and_then(|exit| {
            if exit.success() {
                Ok(target_path.to_string())
            } else {
                Err(format!("Open path command exited with {exit}"))
            }
        })
}

#[tauri::command]
fn bootstrap(store: State<AppStore>) -> Result<BootstrapPayload, String> {
    let state = store.state.lock().map_err(|_| "State lock was poisoned".to_string())?.clone();
    Ok(BootstrapPayload {
        accounts: state.accounts,
        settings: state.settings,
        downloads: state.downloads,
        wechat_preload_url: String::new(),
        app_version: APP_VERSION.to_string(),
    })
}

#[tauri::command]
fn start_engines(app: tauri::AppHandle, store: State<AppStore>) -> Result<bool, String> {
    let accounts = store
        .state
        .lock()
        .map_err(|_| "State lock was poisoned".to_string())?
        .accounts
        .clone();
    wechat_engine::ensure_all(&app, &accounts)?;
    Ok(true)
}

#[tauri::command]
fn create_account_command(name: String, app: tauri::AppHandle, store: State<AppStore>) -> Result<AccountProfile, String> {
    let account = with_state(&store, |state| {
        let account = create_account(name, state.accounts.len());
        state.accounts.push(account.clone());
        account
    })?;
    wechat_engine::ensure_account(&app, &account)?;
    Ok(account)
}

#[tauri::command]
fn update_account(
    account_id: String,
    patch: AccountPatch,
    app: tauri::AppHandle,
    store: State<AppStore>,
) -> Result<Vec<AccountProfile>, String> {
    let accounts = with_state(&store, |state| {
        if let Some(account) = state.accounts.iter_mut().find(|entry| entry.id == account_id) {
            if let Some(name) = patch.name {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    account.name = trimmed.to_string();
                }
            }
            if let Some(enabled) = patch.enabled {
                account.enabled = enabled;
            }
            account.last_used_at = now_iso();
        }
        state.accounts.clone()
    })?;

    if let Some(account) = accounts.iter().find(|entry| entry.id == account_id) {
        if account.enabled {
            wechat_engine::ensure_account(&app, account)?;
        } else {
            wechat_engine::stop_account(&app, &account.id)?;
        }
    }

    Ok(accounts)
}

#[tauri::command]
fn clear_account_session(account_id: String, app: tauri::AppHandle, store: State<AppStore>) -> Result<bool, String> {
    let exists = store
        .state
        .lock()
        .map_err(|_| "State lock was poisoned".to_string())?
        .accounts
        .iter()
        .any(|account| account.id == account_id);
    if exists {
        wechat_engine::clear_account(&app, &account_id)?;
    }
    Ok(exists)
}

#[tauri::command]
fn update_settings(patch: SettingsPatch, store: State<AppStore>) -> Result<AppSettings, String> {
    with_state(&store, |state| {
        if let Some(download_dir) = patch.download_dir {
            if !download_dir.trim().is_empty() {
                state.settings.download_dir = download_dir;
            }
        }
        if let Some(auto_download) = patch.auto_download {
            state.settings.auto_download = auto_download;
        }
        if let Some(download_rules) = patch.download_rules {
            state.settings.download_rules = download_rules;
        }
        if let Some(organize_by_date) = patch.organize_by_date {
            state.settings.organize_by_date = organize_by_date;
        }
        if let Some(launch_at_login) = patch.launch_at_login {
            state.settings.launch_at_login = launch_at_login;
        }
        if let Some(notify_when_downloaded) = patch.notify_when_downloaded {
            state.settings.notify_when_downloaded = notify_when_downloaded;
        }
        if let Some(ui_scale) = patch.ui_scale {
            state.settings.ui_scale = clamp_ui_scale(ui_scale);
        }
        state.settings.clone()
    })
}

#[tauri::command]
fn choose_download_dir(store: State<AppStore>) -> Result<Option<String>, String> {
    let selected = rfd::FileDialog::new().pick_folder();
    if let Some(path) = selected {
        let next = path.to_string_lossy().to_string();
        with_state(&store, |state| {
            state.settings.download_dir = next.clone();
        })?;
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn open_path(target_path: String) -> Result<String, String> {
    open_with_system(&target_path)
}

#[tauri::command]
fn download_from_url(payload: WebviewDownloadPayload, app: tauri::AppHandle, store: State<AppStore>) -> Result<bool, String> {
    wechat_engine::download_from_url(&app, &store, payload)
}

#[tauri::command]
fn send_telemetry(payload: WebviewTelemetryPayload, app: tauri::AppHandle) -> Result<(), String> {
    app.emit("webview-telemetry", payload)
        .map_err(|error| format!("Unable to emit telemetry: {error}"))
}

#[tauri::command]
fn send_text(account_id: String, text: String, app: tauri::AppHandle) -> Result<bool, String> {
    wechat_engine::send_text(&app, &account_id, &text)
}

#[tauri::command]
fn wechat_engine_event(payload: serde_json::Value, app: tauri::AppHandle, store: State<AppStore>) -> Result<(), String> {
    let kind = payload
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();

    if kind == "qr" {
        let qr: WebviewQrPayload =
            serde_json::from_value(payload).map_err(|error| format!("Unable to parse QR event: {error}"))?;
        app.emit("webview-qr", qr)
            .map_err(|error| format!("Unable to emit QR event: {error}"))?;
        return Ok(());
    }

    if kind == "download-url" {
        let download: WebviewDownloadPayload =
            serde_json::from_value(payload).map_err(|error| format!("Unable to parse download event: {error}"))?;
        wechat_engine::download_from_url(&app, &store, download)?;
        return Ok(());
    }

    let telemetry: WebviewTelemetryPayload =
        serde_json::from_value(payload).map_err(|error| format!("Unable to parse WeChat engine event: {error}"))?;
    app.emit("webview-telemetry", telemetry)
        .map_err(|error| format!("Unable to emit WeChat engine event: {error}"))
}

pub fn run() {
    let path = store_path().expect("failed to resolve app state path");
    let state = load_state(&path);

    tauri::Builder::default()
        .manage(AppStore {
            state: Mutex::new(state),
            path,
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("WeChat File Dock");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            start_engines,
            create_account_command,
            update_account,
            clear_account_session,
            update_settings,
            choose_download_dir,
            open_path,
            download_from_url,
            send_telemetry,
            send_text,
            wechat_engine_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
