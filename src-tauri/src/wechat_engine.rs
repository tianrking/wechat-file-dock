use std::{fs, path::PathBuf};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{project_dirs, AccountProfile, WebviewTelemetryPayload};

const WECHAT_FILE_HELPER_URL: &str = "https://filehelper.weixin.qq.com/";

fn engine_label(account_id: &str) -> String {
    format!("wechat-engine-{account_id}")
}

pub(crate) fn session_dir(account_id: &str) -> Result<PathBuf, String> {
    let dir = project_dirs()?
        .data_local_dir()
        .join("sessions")
        .join(account_id);
    fs::create_dir_all(&dir).map_err(|error| format!("Unable to create session directory: {error}"))?;
    Ok(dir)
}

fn build_init_script(account_id: &str) -> Result<String, String> {
    let account = serde_json::to_string(account_id).map_err(|error| format!("Unable to encode account id: {error}"))?;
    Ok(format!(
        r#"
(() => {{
  if (window.__WFD_TAURI_ENGINE__) return;
  window.__WFD_TAURI_ENGINE__ = true;

  const ACCOUNT_ID = {account};
  const invokeCommand = (payload) => {{
    try {{
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof invoke === "function") {{
        invoke("wechat_engine_event", {{ payload }}).catch(() => undefined);
      }}
    }} catch (_error) {{}}
  }};
  const send = (kind, message, details) => invokeCommand({{
    accountId: ACCOUNT_ID,
    kind,
    message,
    details: details || null
  }});

  const classify = () => {{
    const href = String(location.href || "");
    const text = document.body ? String(document.body.innerText || "") : "";
    const hasQrHint = /扫码|二维码|确认登录|登录/.test(text);
    const hasQrNode = Boolean(document.querySelector("canvas, img[src*='qrcode'], img[src*='login']"));
    const hasComposer = Boolean(document.querySelector("[contenteditable='true'], textarea, input"));
    const hasFileHelper = /文件传输助手|File Transfer|filehelper/i.test(text + " " + href);

    if (hasQrHint || hasQrNode || /login|qrcode/i.test(href)) {{
      send("login-required", "WeChat login is required", {{ href }});
      return;
    }}

    if (hasComposer || hasFileHelper) {{
      send("online", "WeChat page is online", {{ href }});
    }}
  }};

  let lastQrSrc = "";
  const absoluteSrc = (src) => {{
    try {{
      return new URL(src, location.href).href;
    }} catch (_error) {{
      return src || "";
    }}
  }};
  const captureQr = () => {{
    const image = Array.from(document.images || []).find((entry) => {{
      const text = `${{entry.src || ""}} ${{entry.alt || ""}} ${{entry.className || ""}} ${{entry.id || ""}}`;
      return /qr|qrcode|login/i.test(text) || (entry.naturalWidth >= 120 && entry.naturalHeight >= 120);
    }});
    let src = image ? absoluteSrc(image.currentSrc || image.src) : "";

    if (!src) {{
      const canvas = Array.from(document.querySelectorAll("canvas")).find((entry) => entry.width >= 120 && entry.height >= 120);
      if (canvas) {{
        try {{
          src = canvas.toDataURL("image/png");
        }} catch (_error) {{}}
      }}
    }}

    if (src && src !== lastQrSrc) {{
      lastQrSrc = src;
      invokeCommand({{
        accountId: ACCOUNT_ID,
        kind: "qr",
        src,
        detectedAt: new Date().toISOString()
      }});
      send("login-required", "WeChat QR code is ready", {{ href: location.href }});
    }}
  }};

  window.addEventListener("DOMContentLoaded", () => {{
    send("loading", "Hidden WeChat session engine loaded", {{ href: location.href }});
    classify();
    captureQr();
  }});
  window.addEventListener("load", () => {{
    classify();
    captureQr();
  }});
  setInterval(() => {{
    classify();
    captureQr();
  }}, 1500);
}})();
"#
    ))
}

fn emit_engine_status(app: &tauri::AppHandle, account_id: &str, kind: &str, message: &str) {
    let _ = app.emit(
        "webview-telemetry",
        WebviewTelemetryPayload {
            account_id: account_id.to_string(),
            kind: kind.to_string(),
            message: Some(message.to_string()),
            details: None,
        },
    );
}

fn emit_session_preserved(app: &tauri::AppHandle, account: &AccountProfile, data_dir: &PathBuf) {
    let _ = app.emit(
        "webview-telemetry",
        WebviewTelemetryPayload {
            account_id: account.id.clone(),
            kind: "session-preserved".to_string(),
            message: Some("Per-account WebView session directory is active".to_string()),
            details: Some(serde_json::json!({
                "accountName": account.name,
                "dataDirectory": data_dir,
                "partition": account.partition
            })),
        },
    );
}

pub(crate) fn ensure_account(app: &tauri::AppHandle, account: &AccountProfile) -> Result<(), String> {
    if !account.enabled {
        return Ok(());
    }

    let label = engine_label(&account.id);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let url = WECHAT_FILE_HELPER_URL
        .parse()
        .map_err(|error| format!("Unable to parse WeChat URL: {error}"))?;
    let init_script = build_init_script(&account.id)?;
    let account_id = account.id.clone();
    let app_for_load = app.clone();

    let data_dir = session_dir(&account.id)?;

    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(format!("WeChat Engine - {}", account.name))
        .visible(false)
        .skip_taskbar(true)
        .inner_size(420.0, 560.0)
        .data_directory(data_dir.clone())
        .initialization_script(&init_script)
        .on_navigation(|target| {
            let target = target.as_str().to_ascii_lowercase();
            !(target.contains("logout") || target.contains("webwxlogout"))
        })
        .on_page_load(move |_webview, payload| {
            emit_engine_status(
                &app_for_load,
                &account_id,
                "loading",
                &format!("WeChat engine loaded {}", payload.url()),
            );
        })
        .build()
        .map_err(|error| format!("Unable to start hidden WeChat engine: {error}"))?;

    emit_session_preserved(app, account, &data_dir);
    Ok(())
}

pub(crate) fn ensure_all(app: &tauri::AppHandle, accounts: &[AccountProfile]) -> Result<(), String> {
    for account in accounts {
        ensure_account(app, account)?;
    }
    Ok(())
}

pub(crate) fn clear_account(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    stop_account(app, account_id)?;

    let dir = session_dir(account_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("Unable to remove session directory: {error}"))?;
    }
    fs::create_dir_all(&dir).map_err(|error| format!("Unable to recreate session directory: {error}"))?;
    Ok(())
}

pub(crate) fn stop_account(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    let label = engine_label(account_id);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("Unable to close hidden WeChat engine: {error}"))?;
    }
    Ok(())
}
