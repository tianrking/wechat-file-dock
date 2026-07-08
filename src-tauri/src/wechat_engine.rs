use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{webview::DownloadEvent, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::{
    now_iso, project_dirs, save_state, AccountProfile, AppSettings, AppStore, DownloadRecord, DownloadRules,
    WebviewDownloadPayload, WebviewTelemetryPayload,
};

const WECHAT_FILE_HELPER_URL: &str = "https://filehelper.weixin.qq.com/";
const MAX_DOWNLOADS: usize = 120;

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

fn timestamp_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn sanitize_filename(filename: &str) -> String {
    let cleaned = filename
        .split(['?', '#'])
        .next()
        .unwrap_or(filename)
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() {
        format!("download-{}.bin", timestamp_ms())
    } else {
        cleaned
    }
}

fn fallback_filename(kind: &str) -> String {
    let ext = match kind {
        "document" => "bin",
        "image" => "jpg",
        "video" => "mp4",
        "audio" => "mp3",
        "archive" => "zip",
        "code" => "txt",
        "app" => "bin",
        _ => "bin",
    };
    format!("wechat-{kind}-{}.{}", timestamp_ms(), ext)
}

fn has_useful_extension(filename: &str) -> bool {
    let ext = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    !ext.is_empty() && ext != "weixin" && ext != "html" && ext != "htm"
}

fn filename_from_url(raw_url: &str, fallback: &str) -> String {
    let parsed = match tauri::Url::parse(raw_url) {
        Ok(url) => url,
        Err(_) => return sanitize_filename(fallback),
    };

    for key in ["filename", "fileName", "name"] {
        if let Some(value) = parsed.query_pairs().find_map(|(name, value)| (name == key).then_some(value.to_string())) {
            let candidate = sanitize_filename(&value);
            if has_useful_extension(&candidate) {
                return candidate;
            }
        }
    }

    let basename = parsed.path_segments().and_then(|mut segments| segments.next_back()).unwrap_or_default();
    let candidate = sanitize_filename(basename);
    if has_useful_extension(&candidate) {
        candidate
    } else {
        sanitize_filename(fallback)
    }
}

fn resolve_download_filename(raw_url: &str, kind: &str, suggested: Option<&str>) -> String {
    if let Some(suggested) = suggested {
        let candidate = sanitize_filename(suggested);
        if has_useful_extension(&candidate) {
            return candidate;
        }
    }

    filename_from_url(raw_url, &fallback_filename(kind))
}

fn today_folder() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn unique_path(target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }

    let parent = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = target.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
    let ext = target.extension().and_then(|value| value.to_str()).unwrap_or_default();

    for index in 1..1000 {
        let filename = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let candidate = parent.join(filename);
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(if ext.is_empty() {
        format!("{stem}-{}", timestamp_ms())
    } else {
        format!("{stem}-{}.{}", timestamp_ms(), ext)
    })
}

fn rule_enabled(rules: &DownloadRules, kind: &str) -> bool {
    match kind {
        "document" => rules.document,
        "image" => rules.image,
        "video" => rules.video,
        "audio" => rules.audio,
        "archive" => rules.archive,
        "code" => rules.code,
        "app" => rules.app,
        _ => rules.other,
    }
}

fn is_allowed_download_url(raw_url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(raw_url) else {
        return false;
    };

    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }

    let hostname = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let pathname = url.path().to_ascii_lowercase();
    let is_file_helper_shell = hostname == "filehelper.weixin.qq.com"
        && !pathname.contains("/cgi-bin/mmwebwx-bin/webwxgetmsgimg")
        && !pathname.contains("/cgi-bin/mmwebwx-bin/webwxgetvideo")
        && !pathname.contains("/cgi-bin/mmwebwx-bin/webwxgetmedia");

    !is_file_helper_shell
        && !pathname.ends_with(".weixin")
        && !pathname.ends_with("feedback.htm")
        && !pathname.ends_with("feedback.html")
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
  const runtime = {{}};
  const parseMaybeJson = (value) => {{
    if (typeof value !== "string" || !value.trim()) return null;
    try {{ return JSON.parse(value); }} catch (_error) {{ return null; }}
  }};
  const asRecord = (value) => value && typeof value === "object" ? value : null;
  const randomDeviceId = () => `e${{Array.from({{ length: 15 }}, () => Math.floor(Math.random() * 10)).join("")}}`;
  const getCookie = (name) => {{
    const escaped = name.replace(/[.*+?^${{}}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${{escaped}}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }};
  const mergeRuntimeFromPayload = (payload) => {{
    const record = asRecord(payload);
    if (!record) return;
    const base = asRecord(record.BaseRequest);
    if (base) {{
      runtime.baseRequest = {{
        Uin: String(base.Uin || ""),
        Sid: String(base.Sid || ""),
        Skey: String(base.Skey || ""),
        DeviceID: String(base.DeviceID || randomDeviceId())
      }};
    }}
    const msg = asRecord(record.Msg);
    if (msg && msg.FromUserName) runtime.userName = String(msg.FromUserName);
  }};
  const mergeRuntimeFromResponse = (payload) => {{
    const record = asRecord(payload);
    if (!record) return;
    const user = asRecord(record.User);
    if (user && user.UserName) runtime.userName = String(user.UserName);
    if (record.pass_ticket) runtime.passTicket = String(record.pass_ticket);
  }};
  const mergeRuntimeFromUrl = (rawUrl) => {{
    try {{
      const url = new URL(rawUrl, location.href);
      const passTicket = url.searchParams.get("pass_ticket");
      if (passTicket) runtime.passTicket = passTicket;
      if (/webwxsendmsg/i.test(url.pathname)) runtime.sendEndpoint = url.href;
    }} catch (_error) {{}}
  }};
  const bootstrapRuntime = () => {{
    const wxuin = getCookie("wxuin");
    const wxsid = getCookie("wxsid");
    const skey = getCookie("skey") || "";
    if (!runtime.baseRequest && wxuin && wxsid) {{
      runtime.baseRequest = {{ Uin: wxuin, Sid: wxsid, Skey: skey, DeviceID: randomDeviceId() }};
    }}
    for (const storage of [localStorage, sessionStorage]) {{
      for (let index = 0; index < storage.length; index += 1) {{
        const key = storage.key(index);
        if (!key) continue;
        const parsed = parseMaybeJson(storage.getItem(key));
        mergeRuntimeFromPayload(parsed);
        mergeRuntimeFromResponse(parsed);
      }}
    }}
  }};
  const isLogoutUrl = (rawUrl) => {{
    try {{
      const url = new URL(rawUrl, location.href);
      return /(^|\.)qq\.com$|(^|\.)wechat\.com$|(^|\.)weixin\.qq\.com$/.test(url.hostname) &&
        (url.pathname.includes("webwxlogout") || url.pathname.includes("/logout"));
    }} catch (_error) {{
      return /webwxlogout/i.test(rawUrl);
    }}
  }};
  const installNetworkCapture = () => {{
    if (window.__WFD_NETWORK_CAPTURE__) return;
    window.__WFD_NETWORK_CAPTURE__ = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {{
      this.__wfdUrl = String(url);
      mergeRuntimeFromUrl(this.__wfdUrl);
      return originalOpen.apply(this, [method, url, ...rest]);
    }};
    XMLHttpRequest.prototype.send = function patchedSend(body) {{
      const rawUrl = this.__wfdUrl || "";
      mergeRuntimeFromPayload(parseMaybeJson(typeof body === "string" ? body : ""));
      if (isLogoutUrl(rawUrl)) {{
        send("session-preserved", "Blocked WeChat logout request", {{ url: rawUrl.slice(0, 180) }});
        try {{ this.abort(); }} catch (_error) {{}}
        return;
      }}
      this.addEventListener("loadend", () => {{
        if (/webwxinit|webwxsendmsg|webwxsync/i.test(rawUrl)) {{
          mergeRuntimeFromUrl(rawUrl);
          mergeRuntimeFromResponse(parseMaybeJson(this.responseText));
        }}
      }});
      return originalSend.call(this, body);
    }};
    if (window.fetch) {{
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {{
        const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        mergeRuntimeFromUrl(rawUrl);
        mergeRuntimeFromPayload(parseMaybeJson(typeof (init && init.body) === "string" ? init.body : ""));
        if (isLogoutUrl(rawUrl)) {{
          send("session-preserved", "Blocked WeChat logout fetch", {{ url: rawUrl.slice(0, 180) }});
          return new Response(null, {{ status: 204, statusText: "Blocked by WeChat File Dock" }});
        }}
        const response = await originalFetch(input, init);
        if (/webwxinit|webwxsendmsg|webwxsync/i.test(rawUrl)) {{
          response.clone().text().then((text) => mergeRuntimeFromResponse(parseMaybeJson(text))).catch(() => undefined);
        }}
        return response;
      }};
    }}
  }};
  const normalizeTextContent = (text) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const makeClientMessageId = () => `${{Date.now()}}${{Math.floor(Math.random() * 10000).toString().padStart(4, "0")}}`;
  const resolveSendEndpoint = () => {{
    if (runtime.sendEndpoint) return runtime.sendEndpoint;
    const url = new URL("/cgi-bin/mmwebwx-bin/webwxsendmsg", location.origin);
    if (runtime.passTicket) url.searchParams.set("pass_ticket", runtime.passTicket);
    return url.href;
  }};
  const visible = (element) => {{
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
  }};
  const insertText = (target, text) => {{
    target.focus();
    const selection = getSelection();
    if (target.isContentEditable && selection) {{
      document.execCommand("insertText", false, text);
    }} else if ("value" in target) {{
      const start = target.selectionStart || target.value.length;
      const end = target.selectionEnd || target.value.length;
      target.value = `${{target.value.slice(0, start)}}${{text}}${{target.value.slice(end)}}`;
      target.setSelectionRange(start + text.length, start + text.length);
    }}
    target.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: text }}));
    target.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  const findComposer = () => Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"))
    .reverse()
    .find((element) => visible(element) && !element.hasAttribute("disabled"));
  const findSendButton = () => Array.from(document.querySelectorAll("button, [role='button'], a"))
    .reverse()
    .find((element) => visible(element) && /^(send|\u53d1\u9001)$/i.test((element.textContent || "").trim()) && !element.hasAttribute("disabled"));
  const sendTextViaApi = async (text) => {{
    bootstrapRuntime();
    if (!runtime.baseRequest || !runtime.userName) return {{ ok: false, method: "api-not-ready" }};
    const clientMsgId = makeClientMessageId();
    const response = await fetch(resolveSendEndpoint(), {{
      method: "POST",
      credentials: "include",
      headers: {{ "Content-Type": "application/json;charset=UTF-8" }},
      body: JSON.stringify({{
        BaseRequest: runtime.baseRequest,
        Msg: {{
          Type: 1,
          Content: normalizeTextContent(text),
          FromUserName: runtime.userName,
          ToUserName: "filehelper",
          LocalID: clientMsgId,
          ClientMsgId: clientMsgId
        }},
        Scene: 0
      }})
    }});
    const result = await response.json();
    const ret = result && result.BaseResponse ? result.BaseResponse.Ret : undefined;
    if (ret === 0) return {{ ok: true, method: "webwxsendmsg", clientMsgId }};
    return {{ ok: false, method: "webwxsendmsg", message: result && result.BaseResponse ? result.BaseResponse.ErrMsg || String(ret) : "unknown" }};
  }};
  const sendTextViaDom = async (text) => {{
    const composer = findComposer();
    if (!composer) return {{ ok: false, method: "dom-not-ready" }};
    insertText(composer, text);
    const button = findSendButton();
    if (button) {{
      button.click();
      return {{ ok: true, method: "dom-button" }};
    }}
    composer.dispatchEvent(new KeyboardEvent("keydown", {{ key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }}));
    return {{ ok: true, method: "dom-enter" }};
  }};
  window.__WFD_SEND_TEXT__ = async (text) => {{
    const content = String(text || "").trim();
    if (!content) return {{ ok: false, method: "empty", message: "empty text" }};
    send("text-send-result", "Sending text through hidden WeChat session", {{ method: "start" }});
    try {{
      const apiResult = await sendTextViaApi(content);
      if (apiResult.ok) {{
        send("text-send-result", "Text sent through hidden WeChat web session", apiResult);
        return apiResult;
      }}
      const domResult = await sendTextViaDom(content);
      if (domResult.ok) {{
        send("text-send-result", "Text sent through hidden DOM fallback", domResult);
        return domResult;
      }}
      const failed = {{ ok: false, method: "none", message: apiResult.message || domResult.message || "WeChat send channel was not ready" }};
      send("text-send-result", `Text send failed: ${{failed.message}}`, failed);
      return failed;
    }} catch (error) {{
      const failed = {{ ok: false, method: "error", message: error && error.message ? error.message : String(error) }};
      send("text-send-result", `Text send failed: ${{failed.message}}`, failed);
      return failed;
    }}
  }};
  installNetworkCapture();
  bootstrapRuntime();

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

  const sentUrls = new Map();
  const mediaEndpointPattern = /webwxgetmsgimg|webwxgetvideo|webwxgetmedia|getmsgimg|getvideo|getmedia|download|attachment/i;
  const fileHelperMediaPathPattern = /\/cgi-bin\/mmwebwx-bin\/webwxget(?:msgimg|video|media)/i;
  const knownExtensionPattern = /\.(7z|aac|apk|appx|avi|bin|bmp|bz2|c|cc|cpp|cs|csv|css|deb|dmg|docx?|exe|flac|gif|go|gz|heic|html?|ipa|iso|java|jpe?g|js|json|jsx|key|kt|log|m4a|m4v|md|mkv|mov|mp3|mp4|msi|ogg|opus|pages|pdf|php|pkg|png|pptx?|py|rar|rpm|rs|rtf|sh|sql|svg|swift|tar|tgz|tiff?|toml|ts|tsx|txt|ufw|wav|webm|webp|wma|xlsx?|xml|xz|yaml|yml|zip)(?:$|[?#&])/i;
  const classifyDownload = (value, fallback) => {{
    if (/\.(avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|webm|wmv)(?:$|[?#&])|webwxgetvideo|getvideo|video/i.test(value)) return "video";
    if (/\.(aac|aiff?|flac|m4a|mp3|ogg|opus|wav|wma)(?:$|[?#&])|audio|voice/i.test(value)) return "audio";
    if (/\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:$|[?#&])|webwxgetmsgimg|getmsgimg|image|photo/i.test(value)) return "image";
    if (/\.(7z|bz2|gz|iso|rar|tar|tgz|xz|zip)(?:$|[?#&])/i.test(value)) return "archive";
    if (/\.(apk|appx|bin|deb|dmg|exe|ipa|msi|pkg|rpm|ufw)(?:$|[?#&])/i.test(value)) return "app";
    if (/\.(c|cc|cpp|cs|css|go|h|hpp|html?|java|js|json|jsx|kt|log|lua|md|php|py|rs|sh|sql|swift|toml|ts|tsx|xml|yaml|yml)(?:$|[?#&])/i.test(value)) return "code";
    if (/\.(csv|docx?|key|numbers|pages|pdf|pptx?|rtf|txt|xlsx?)(?:$|[?#&])/i.test(value)) return "document";
    if (knownExtensionPattern.test(value) || /file|attachment|webwxgetmedia|getmedia|download/i.test(value)) return "other";
    return fallback || "";
  }};
  const isInternalShellUrl = (rawUrl) => {{
    try {{
      const url = new URL(rawUrl, location.href);
      const pathname = url.pathname.toLowerCase();
      if (pathname.endsWith(".weixin") || /feedback\.html?$/i.test(pathname)) return true;
      return url.hostname.toLowerCase() === "filehelper.weixin.qq.com" && !fileHelperMediaPathPattern.test(pathname);
    }} catch (_error) {{
      return /\.weixin(?:$|[?#])|feedback\.html?/i.test(rawUrl);
    }}
  }};
  const contextText = (element) => {{
    const chunks = [];
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {{
      chunks.push([
        current.textContent || "",
        current.getAttribute && (current.getAttribute("title") || ""),
        current.getAttribute && (current.getAttribute("aria-label") || ""),
        current.getAttribute && (current.getAttribute("download") || ""),
        current.getAttribute && (current.getAttribute("href") || ""),
        current.getAttribute && (current.getAttribute("src") || "")
      ].join(" "));
      current = current.parentElement;
    }}
    return chunks.join(" ").replace(/\s+/g, " ").trim();
  }};
  const filenameFromText = (value) => {{
    const match = value.match(/[^\s"'<>\\/|:*?]+?\.[a-z0-9]{{1,8}}\b/i);
    return match && match[0] ? match[0] : undefined;
  }};
  const absoluteDownloadUrl = (raw) => {{
    if (!raw || /^data:|^blob:/i.test(raw)) return "";
    try {{ return new URL(raw, location.href).href; }} catch (_error) {{ return ""; }}
  }};
  const sendDownload = (url, fileKind, filename, sourceText) => {{
    if (!url || !fileKind || isInternalShellUrl(url)) return;
    const key = `${{fileKind}}:${{url}}`;
    const now = Date.now();
    if ((sentUrls.get(key) || 0) > now - 90000) return;
    sentUrls.set(key, now);
    invokeCommand({{
      accountId: ACCOUNT_ID,
      kind: "download-url",
      url,
      filename: filename || null,
      sourceText: sourceText || null
    }});
    send("download-url", `queued ${{fileKind}}`, {{ url: url.slice(0, 180), filename: filename || null }});
  }};
  const scanDownloads = () => {{
    for (const node of Array.from(document.querySelectorAll("a[href], img[src], video[src], source[src], [data-src], [data-url], [data-href]"))) {{
      const raw = node.getAttribute("href") || node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-url") || node.getAttribute("data-href") || "";
      const url = absoluteDownloadUrl(raw);
      if (!url) continue;
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : {{ width: 0, height: 0 }};
      const sourceText = `${{contextText(node)}} ${{url}}`;
      const fallback = node.tagName === "IMG" && rect.width >= 72 && rect.height >= 72 ? "image" : "";
      const fileKind = classifyDownload(sourceText, fallback);
      if (!fileKind) continue;
      if (!mediaEndpointPattern.test(url) && !knownExtensionPattern.test(sourceText)) continue;
      sendDownload(url, fileKind, filenameFromText(sourceText), sourceText.slice(0, 240));
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
    scanDownloads();
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

fn base_save_dir(settings: &AppSettings, account: &AccountProfile) -> PathBuf {
    let base = PathBuf::from(&settings.download_dir);
    if settings.organize_by_date {
        base.join(today_folder()).join(&account.name)
    } else {
        base.join(&account.name)
    }
}

fn emit_telemetry(app: &tauri::AppHandle, payload: WebviewTelemetryPayload) {
    let _ = app.emit("webview-telemetry", payload);
}

fn upsert_download(store: &AppStore, record: DownloadRecord) -> Result<(), String> {
    let mut guard = store.state.lock().map_err(|_| "State lock was poisoned".to_string())?;
    let record_id = record.id.clone();
    guard.downloads = std::iter::once(record)
        .chain(guard.downloads.iter().filter(|entry| entry.id != record_id).cloned())
        .take(MAX_DOWNLOADS)
        .collect();
    save_state(&store.path, &guard)
}

fn account_and_settings(store: &State<AppStore>, account_id: &str) -> Result<Option<(AccountProfile, AppSettings)>, String> {
    let guard = store.state.lock().map_err(|_| "State lock was poisoned".to_string())?;
    Ok(guard
        .accounts
        .iter()
        .find(|entry| entry.id == account_id)
        .cloned()
        .map(|account| (account, guard.settings.clone())))
}

pub(crate) fn download_from_url(
    app: &tauri::AppHandle,
    store: &State<AppStore>,
    payload: WebviewDownloadPayload,
) -> Result<bool, String> {
    let Some((account, settings)) = account_and_settings(store, &payload.account_id)? else {
        return Ok(false);
    };

    if !settings.auto_download || !rule_enabled(&settings.download_rules, &payload.kind) {
        return Ok(false);
    }

    if !is_allowed_download_url(&payload.url) {
        emit_telemetry(
            app,
            WebviewTelemetryPayload {
                account_id: payload.account_id,
                kind: "download-error".to_string(),
                message: Some("Ignored non-file WeChat URL".to_string()),
                details: Some(serde_json::json!({
                    "url": payload.url,
                    "kind": payload.kind
                })),
            },
        );
        return Ok(false);
    }

    let label = format!("wechat-download-{}", Uuid::new_v4().simple());
    let requested_url = payload.url.clone();
    let requested_url_for_load = requested_url.clone();
    let requested_url_for_download = requested_url.clone();
    let account_id = account.id.clone();
    let account_name = account.name.clone();
    let file_kind = payload.kind.clone();
    let filename = resolve_download_filename(&requested_url, &file_kind, payload.filename.as_deref());
    let filename_for_load = filename.clone();
    let filename_for_download = filename.clone();
    let record_id = Uuid::new_v4().to_string();
    let save_root = base_save_dir(&settings, &account);
    fs::create_dir_all(&save_root).map_err(|error| format!("Unable to create download directory: {error}"))?;

    let current_record: Arc<Mutex<Option<DownloadRecord>>> = Arc::new(Mutex::new(None));
    let trigger_once = Arc::new(Mutex::new(false));
    let app_for_download = app.clone();
    let app_for_emit = app.clone();
    let record_for_download = Arc::clone(&current_record);
    let trigger_for_load = Arc::clone(&trigger_once);
    let save_root_for_download = save_root.clone();

    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(WECHAT_FILE_HELPER_URL.parse().map_err(|error| format!("Unable to parse WeChat URL: {error}"))?),
    )
    .visible(false)
    .skip_taskbar(true)
    .inner_size(360.0, 420.0)
    .data_directory(session_dir(&account.id)?)
    .on_page_load(move |webview, _payload| {
        let Ok(mut fired) = trigger_for_load.lock() else {
            return;
        };
        if *fired {
            return;
        }
        *fired = true;

        let url_json = serde_json::to_string(&requested_url_for_load).unwrap_or_else(|_| "\"\"".to_string());
        let filename_json = serde_json::to_string(&filename_for_load).unwrap_or_else(|_| "\"\"".to_string());
        let _ = webview.eval(&format!(
            r#"
(() => {{
  const a = document.createElement("a");
  a.href = {url_json};
  a.download = {filename_json};
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}})();
"#
        ));
    })
    .on_download(move |webview, event| match event {
        DownloadEvent::Requested { destination, .. } => {
            let save_path = unique_path(save_root_for_download.join(&filename_for_download));
            *destination = save_path.clone();
            let record = DownloadRecord {
                id: record_id.clone(),
                account_id: account_id.clone(),
                account_name: account_name.clone(),
                filename: filename_for_download.clone(),
                save_path: save_path.to_string_lossy().to_string(),
                url: requested_url_for_download.clone(),
                state: "progressing".to_string(),
                received_bytes: 0,
                total_bytes: 0,
                started_at: now_iso(),
                ended_at: None,
            };

            if let Ok(mut guard) = record_for_download.lock() {
                *guard = Some(record.clone());
            }

            let store = app_for_download.state::<AppStore>();
            let _ = upsert_download(&store, record.clone());
            let _ = app_for_download.emit("downloads-changed", serde_json::json!({ "record": record }));
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            let maybe_record = record_for_download.lock().ok().and_then(|guard| guard.clone());
            if let Some(mut record) = maybe_record {
                if let Some(path) = path {
                    record.save_path = path.to_string_lossy().to_string();
                }
                record.state = if success { "completed" } else { "interrupted" }.to_string();
                record.ended_at = Some(now_iso());

                let store = app_for_download.state::<AppStore>();
                let _ = upsert_download(&store, record.clone());
                let _ = app_for_download.emit("downloads-changed", serde_json::json!({ "record": record }));
            }
            let _ = webview.close();
            true
        }
        _ => true,
    })
    .build()
    .map_err(|error| format!("Unable to start hidden downloader: {error}"))?;

    emit_telemetry(
        &app_for_emit,
        WebviewTelemetryPayload {
            account_id: account.id,
            kind: "download-url".to_string(),
            message: Some("Queued download through isolated Tauri session".to_string()),
            details: Some(serde_json::json!({
                "filename": filename,
                "saveDirectory": save_root,
                "sourceText": payload.source_text
            })),
        },
    );

    Ok(true)
}

pub(crate) fn send_text(app: &tauri::AppHandle, account_id: &str, text: &str) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(&engine_label(account_id)) else {
        emit_telemetry(
            app,
            WebviewTelemetryPayload {
                account_id: account_id.to_string(),
                kind: "text-send-result".to_string(),
                message: Some("Text send failed: hidden WeChat engine is not running".to_string()),
                details: Some(serde_json::json!({ "method": "missing-engine" })),
            },
        );
        return Ok(false);
    };

    let content = text.trim();
    if content.is_empty() {
        return Ok(false);
    }

    let text_json = serde_json::to_string(content).map_err(|error| format!("Unable to encode text: {error}"))?;
    let script = format!(
        r#"
(async () => {{
  if (typeof window.__WFD_SEND_TEXT__ !== "function") {{
    return {{ ok: false, method: "not-ready", message: "WeChat send bridge is not ready" }};
  }}
  return await window.__WFD_SEND_TEXT__({text_json});
}})();
"#
    );

    let (tx, rx) = mpsc::channel();
    window
        .eval_with_callback(script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Unable to evaluate send script: {error}"))?;

    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Timed out waiting for WeChat send result".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&result).map_err(|error| format!("Unable to parse send result: {error}; raw={result}"))?;
    let ok = value.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);

    if !ok {
        emit_telemetry(
            app,
            WebviewTelemetryPayload {
                account_id: account_id.to_string(),
                kind: "text-send-result".to_string(),
                message: Some(format!(
                    "Text send failed: {}",
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("WeChat send channel was not ready")
                )),
                details: Some(value),
            },
        );
    }

    Ok(ok)
}
