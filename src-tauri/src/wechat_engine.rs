use std::{fs, path::PathBuf};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{project_dirs, AccountProfile, WebviewTelemetryPayload};

const WECHAT_FILE_HELPER_URL: &str = "https://filehelper.weixin.qq.com/";

fn engine_label(account_id: &str) -> String {
    format!("wechat-engine-{account_id}")
}

fn session_dir(account_id: &str) -> Result<PathBuf, String> {
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
  const send = (kind, message, details) => {{
    try {{
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof invoke === "function") {{
        invoke("wechat_engine_event", {{
          payload: {{
            accountId: ACCOUNT_ID,
            kind,
            message,
            details: details || null
          }}
        }}).catch(() => undefined);
      }}
    }} catch (_error) {{}}
  }};

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

  window.addEventListener("DOMContentLoaded", () => {{
    send("loading", "Hidden WeChat session engine loaded", {{ href: location.href }});
    classify();
  }});
  window.addEventListener("load", classify);
  setInterval(classify, 1500);
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

    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(format!("WeChat Engine - {}", account.name))
        .visible(false)
        .skip_taskbar(true)
        .inner_size(420.0, 560.0)
        .data_directory(session_dir(&account.id)?)
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

    Ok(())
}

pub(crate) fn ensure_all(app: &tauri::AppHandle, accounts: &[AccountProfile]) -> Result<(), String> {
    for account in accounts {
        ensure_account(app, account)?;
    }
    Ok(())
}

pub(crate) fn clear_account(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    let label = engine_label(account_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.clear_all_browsing_data();
        let _ = window.close();
    }

    let dir = session_dir(account_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("Unable to remove session directory: {error}"))?;
    }
    fs::create_dir_all(&dir).map_err(|error| format!("Unable to recreate session directory: {error}"))?;
    Ok(())
}
