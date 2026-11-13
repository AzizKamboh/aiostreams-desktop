//! Adapter between the existing desktop shell and its private backend.
//! Keeps backend lifecycle messages separate from the upstream player protocol.

use std::sync::{Arc, OnceLock};

use aiostreams_desktop_core::bridge::Inbound;
use serde_json::Value;

use crate::backend::Backend;

static BACKEND: OnceLock<Arc<Backend>> = OnceLock::new();

#[cfg(windows)]
pub fn install(backend: Arc<Backend>) {
    let for_downloads = backend.clone();
    aiostreams_desktop_core::downloads::set_url_authorizer(move |url| for_downloads.media_url(url));
    let _ = BACKEND.set(backend);
}

pub fn get() -> Option<&'static Arc<Backend>> {
    BACKEND.get()
}

pub fn trusted(url: &str) -> bool {
    get().is_some_and(|backend| backend.is_origin(url))
}

/// Pages that may use the native bridge: the bundled client only, not every
/// response the local server can send.
pub fn bridge_trusted(url: &str) -> bool {
    get().is_some_and(|backend| backend.is_client_page(url))
}

/// Only called after the shell has checked the sending page's origin.
#[cfg(windows)]
pub fn receive(body: &str, send: &dyn Fn(crate::UserEvent)) -> bool {
    if body.len() > 4 * 1024 * 1024 {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let Some(kind) = value["type"].as_str() else {
        return false;
    };
    if !kind.starts_with("backend-") {
        return false;
    }
    let Some(backend) = get() else {
        return true;
    };
    match kind {
        "backend-status" => send(crate::UserEvent::BackendState(backend.status())),
        "backend-restart" => backend.restart(),
        "backend-storage-reset" => {
            if let Err(error) = backend.reset_storage() {
                log::warn!("could not reset the desktop browser settings: {error}");
            }
        }
        "backend-accounts-save" => {
            let result = backend.save_accounts(&value);
            let reply = serde_json::json!({
                "type": "backend-accounts-result",
                "ok": result.is_ok(),
                "message": result.err(),
            });
            send(crate::UserEvent::Emit(format!(
                "window.__aiostreamsAppReceive?.({reply})"
            )));
        }
        "backend-accounts-ack" => backend.forget_new_credential(),
        "backend-storage" => {
            let values = value["values"].clone();
            let valid = values.as_object().is_some_and(|map| {
                map.len() <= 2000 && map.iter().all(|(k, v)| k.len() <= 2048 && v.is_string())
            });
            if valid && backend.save_storage(values).is_err() {
                log::warn!("could not persist the desktop browser settings");
            }
        }
        _ => {}
    }
    true
}

/// Secrets go on the local request's query, never a header that mpv might
/// forward to an unrelated host when following a provider's redirect.
pub fn authorize_media(message: &mut Inbound) {
    let Some(backend) = get() else { return };
    let url = match message {
        Inbound::PlayerLoad { load, .. } => Some(&mut load.url),
        Inbound::PlayerSubtitleAdd { url, .. } | Inbound::PlayerThumbnail { url, .. } => Some(url),
        _ => None,
    };
    if let Some(url) = url {
        *url = backend.media_url(url);
    }
}

/// The UI compares player URLs with the original URL it submitted. Keep the
/// transport capability private, and keep native thumbnail requests on the
/// custom protocol even though the main client now runs on a loopback origin.
pub fn public_message(value: &mut Value) {
    match value {
        Value::String(text) if text.starts_with("/thumbnail/") => {
            *text = format!("{}{}", crate::platform::APP_URL.trim_end_matches('/'), text);
        }
        Value::String(text) if trusted(text) => {
            *text = without_capability(text);
        }
        Value::Array(items) => items.iter_mut().for_each(public_message),
        Value::Object(object) => object.values_mut().for_each(public_message),
        _ => {}
    }
}

#[cfg(windows)]
pub fn configure_webview_runtime() {
    let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("webview2")))
    else {
        return;
    };
    if directory.join("msedgewebview2.exe").is_file() {
        // Called before Velopack, logging, the process manager or any web view can start threads.
        unsafe {
            std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", directory);
        }
    }
}

/// Retains signed query bytes exactly; parsing and re-encoding would alter them.
fn without_capability(text: &str) -> String {
    let Some((head, tail)) = text.split_once('?') else {
        return text.into();
    };
    let (query, fragment) = tail
        .split_once('#')
        .map_or((tail, None), |(q, f)| (q, Some(f)));
    let pairs: Vec<_> = query.split('&').collect();
    if !pairs
        .iter()
        .any(|pair| pair.split('=').next() == Some("__desktop_token"))
    {
        return text.into();
    }
    let kept: Vec<_> = pairs
        .into_iter()
        .filter(|pair| pair.split('=').next() != Some("__desktop_token"))
        .collect();
    let mut result = head.to_owned();
    if !kept.is_empty() {
        result.push('?');
        result.push_str(&kept.join("&"));
    }
    if let Some(fragment) = fragment {
        result.push('#');
        result.push_str(fragment);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::without_capability;
    #[test]
    fn strips_only_capability_without_changing_signed_query_bytes() {
        assert_eq!(
            without_capability(
                "http://127.0.0.1:2/play?sig=a%2fb+x&__desktop_token=private&x=%20#f"
            ),
            "http://127.0.0.1:2/play?sig=a%2fb+x&x=%20#f"
        );
        assert_eq!(
            without_capability("http://127.0.0.1:2/play?sig=a%2fb+x"),
            "http://127.0.0.1:2/play?sig=a%2fb+x"
        );
        assert_eq!(
            without_capability("http://127.0.0.1:2/play?__desktop_token=private#f"),
            "http://127.0.0.1:2/play#f"
        );
    }
}
