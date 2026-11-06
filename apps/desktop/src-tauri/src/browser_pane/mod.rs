//! Browser tabs: one child webview per live tab, placed over the tab's body by the front end.
//!
//! Safety: the webview label starts with `browser-`, which no capability names, and a page may
//! load only `http`/`https` away from the app's own origins (`address::navigation_allowed`), so a
//! page never reaches an app or plugin command. Popups become new tabs of the front end.

pub mod address;
pub mod pool;

use std::sync::{Mutex, PoisonError};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview,
    WebviewBuilder, WebviewUrl,
};

use crate::commands::CmdError;
use crate::settings;
use crate::settings::SettingsSection;
use crate::settings_store;
use pool::{Bounds, Pool};

/// A page's address, title or loading state changed.
pub const PAGE_EVENT: &str = "browser://page";
/// A tab's webview was closed to stay under the live limit; the tab keeps its URL.
pub const EVICTED_EVENT: &str = "browser://evicted";
/// A page asked for a new window; the front end opens it as a tab.
pub const POPUP_EVENT: &str = "browser://popup";
/// The front end's webview, the only one that hears these events.
const MAIN: &str = "main";

#[derive(Default)]
pub struct BrowserPanes {
    pool: Mutex<Pool>,
}

/// The payload of `PAGE_EVENT`.
#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub loading: Option<bool>,
}

/// The payload of `EVICTED_EVENT` and `POPUP_EVENT`.
#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabUrl {
    pub tab: String,
    pub url: String,
}

fn err(code: &'static str, detail: impl ToString) -> CmdError {
    CmdError {
        code,
        detail: Some(detail.to_string()),
    }
}

fn dev_origin(app: &AppHandle) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

fn webview_of(app: &AppHandle, tab: &str) -> Option<Webview> {
    app.get_webview(&pool::label_of(tab))
}

fn rect(b: Bounds) -> Rect {
    Rect {
        position: LogicalPosition::new(b.x, b.y).into(),
        size: LogicalSize::new(b.width, b.height).into(),
    }
}

/// A URL a page may open, or `about:blank`.
fn safe_url(raw: &str, dev: Option<&Url>) -> Url {
    Url::parse(raw)
        .ok()
        .filter(|u| address::navigation_allowed(u, dev))
        .unwrap_or_else(|| Url::parse(address::BLANK).expect("about:blank parses"))
}

fn page(app: &AppHandle, payload: BrowserPage) {
    // Fails only while the app shuts down.
    let _ = app.emit_to(MAIN, PAGE_EVENT, payload);
}

fn builder(app: &AppHandle, tab: &str, url: Url, dev: Option<Url>) -> WebviewBuilder<tauri::Wry> {
    let label = pool::label_of(tab);
    let (on_load, on_title, on_popup) = (app.clone(), app.clone(), app.clone());
    let (tab_load, tab_title, tab_popup) = (tab.to_owned(), tab.to_owned(), tab.to_owned());
    let dev_popup = dev.clone();
    WebviewBuilder::new(label, WebviewUrl::External(url))
        .focused(false)
        .on_navigation(move |url| address::navigation_allowed(url, dev.as_ref()))
        .on_page_load(move |_, load| {
            page(
                &on_load,
                BrowserPage {
                    tab: tab_load.clone(),
                    url: Some(load.url().to_string()),
                    title: None,
                    loading: Some(matches!(load.event(), PageLoadEvent::Started)),
                },
            )
        })
        .on_document_title_changed(move |_, title| {
            page(
                &on_title,
                BrowserPage {
                    tab: tab_title.clone(),
                    url: None,
                    title: Some(title),
                    loading: None,
                },
            )
        })
        .on_new_window(move |url, _| {
            if address::navigation_allowed(&url, dev_popup.as_ref())
                && url.as_str() != address::BLANK
            {
                let _ = on_popup.emit_to(
                    MAIN,
                    POPUP_EVENT,
                    BrowserTabUrl {
                        tab: tab_popup.clone(),
                        url: url.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        })
}

/// Closes the webviews of `tabs` and tells the front end they sleep now.
fn evict(app: &AppHandle, tabs: Vec<String>) {
    for tab in tabs {
        if let Some(view) = webview_of(app, &tab) {
            let url = view.url().map(|u| u.to_string()).unwrap_or_default();
            let _ = view.close();
            let _ = app.emit_to(MAIN, EVICTED_EVENT, BrowserTabUrl { tab, url });
        }
    }
}

/// Shows `tab`'s page over `bounds` (logical pixels in the window), making its webview when the
/// tab has none, at `url`. Closes the least recently shown webview past the live limit.
#[tauri::command(async)]
pub fn browser_show(
    app: AppHandle,
    caller: Webview,
    state: State<'_, BrowserPanes>,
    tab: String,
    url: String,
    bounds: Bounds,
) -> Result<(), CmdError> {
    let Some(bounds) = pool::clamp_bounds(bounds) else {
        return browser_hide(app, tab);
    };
    let view = match webview_of(&app, &tab) {
        Some(view) => view,
        None => {
            let dev = dev_origin(&app);
            let start = safe_url(&url, dev.as_ref());
            let window = caller.window();
            window
                .add_child(
                    builder(&app, &tab, start, dev),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                )
                .map_err(|e| err("browser_unavailable", e))?
        }
    };
    view.set_bounds(rect(bounds))
        .map_err(|e| err("browser_unavailable", e))?;
    view.show().map_err(|e| err("browser_unavailable", e))?;
    let evicted = state
        .pool
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .touch(&tab);
    evict(&app, evicted);
    Ok(())
}

/// Moves `tab`'s webview; an empty or broken rectangle hides it.
#[tauri::command(async)]
pub fn browser_set_bounds(app: AppHandle, tab: String, bounds: Bounds) -> Result<(), CmdError> {
    let Some(view) = webview_of(&app, &tab) else {
        return Ok(());
    };
    match pool::clamp_bounds(bounds) {
        Some(b) => view
            .set_bounds(rect(b))
            .map_err(|e| err("browser_unavailable", e)),
        None => view.hide().map_err(|e| err("browser_unavailable", e)),
    }
}

/// Hides `tab`'s webview; the page keeps running and keeps its state.
#[tauri::command(async)]
pub fn browser_hide(app: AppHandle, tab: String) -> Result<(), CmdError> {
    match webview_of(&app, &tab) {
        Some(view) => view.hide().map_err(|e| err("browser_unavailable", e)),
        None => Ok(()),
    }
}

/// Closes `tab`'s webview for good.
#[tauri::command(async)]
pub fn browser_close(
    app: AppHandle,
    state: State<'_, BrowserPanes>,
    tab: String,
) -> Result<(), CmdError> {
    state
        .pool
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&tab);
    match webview_of(&app, &tab) {
        Some(view) => view.close().map_err(|e| err("browser_unavailable", e)),
        None => Ok(()),
    }
}

/// The URL the typed `input` names (see `address::normalize_address`), loaded in `tab`'s webview
/// when it has one. A sleeping tab gets the URL on its next `browser_show`.
#[tauri::command(async)]
pub fn browser_navigate(app: AppHandle, tab: String, input: String) -> Result<String, CmdError> {
    let template = settings_store::read(&app).browser.search_template;
    let url = address::normalize_address(&input, &template).map_err(|e| err(e.code(), &input))?;
    let parsed = Url::parse(&url).map_err(|e| err("browser_invalid", e))?;
    if !address::navigation_allowed(&parsed, dev_origin(&app).as_ref()) {
        return Err(err("browser_blocked", &url));
    }
    if let Some(view) = webview_of(&app, &tab) {
        view.navigate(parsed)
            .map_err(|e| err("browser_unavailable", e))?;
    }
    Ok(url)
}

/// Back (`-1`) or forward (`1`) in `tab`'s history.
#[tauri::command(async)]
pub fn browser_history(app: AppHandle, tab: String, step: i32) -> Result<(), CmdError> {
    let Some(view) = webview_of(&app, &tab) else {
        return Ok(());
    };
    let js = if step < 0 {
        "history.back()"
    } else {
        "history.forward()"
    };
    view.eval(js).map_err(|e| err("browser_unavailable", e))
}

/// Reloads `tab`'s page. `hard` loads its address again instead of reloading; the engine has no
/// cache bypass the app can ask for.
#[tauri::command(async)]
pub fn browser_reload(app: AppHandle, tab: String, hard: bool) -> Result<(), CmdError> {
    let Some(view) = webview_of(&app, &tab) else {
        return Ok(());
    };
    let done = if hard {
        view.url().and_then(|u| view.navigate(u))
    } else {
        view.reload()
    };
    done.map_err(|e| err("browser_unavailable", e))
}

/// Opens the developer tools of `tab`'s page.
#[tauri::command(async)]
pub fn browser_devtools(app: AppHandle, tab: String) {
    if let Some(view) = webview_of(&app, &tab) {
        view.open_devtools();
    }
}

#[tauri::command(async)]
pub fn browser_settings_get(app: AppHandle) -> settings::BrowserSettings {
    settings_store::read(&app).browser
}

/// Saves Settings → Browser; a search address must be `http(s)` with `%s`, or empty.
#[tauri::command(async)]
pub fn browser_settings_put(
    app: AppHandle,
    settings: settings::BrowserSettings,
) -> Result<settings::BrowserSettings, CmdError> {
    let settings = settings::BrowserSettings {
        search_template: settings.search_template.trim().to_owned(),
        ..settings
    };
    if !address::template_valid(&settings.search_template) {
        return Err(err("browser_template", &settings.search_template));
    }
    settings_store::write(&app, &[SettingsSection::Browser], |s| s.browser = settings)
        .map(|s| s.browser)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_start_urls_become_blank() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert_eq!(
            safe_url("https://example.com/a", Some(&dev)).as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            safe_url("http://localhost:1420/", Some(&dev)).as_str(),
            "about:blank"
        );
        assert_eq!(
            safe_url("http://tauri.localhost/", None).as_str(),
            "about:blank"
        );
        assert_eq!(
            safe_url("javascript:alert(1)", None).as_str(),
            "about:blank"
        );
        assert_eq!(safe_url("not a url", None).as_str(), "about:blank");
    }

    #[test]
    fn browser_settings_read_leniently() {
        let s: settings::BrowserSettings = serde_json::from_str(
            r#"{"openLinksIn":"pane","searchTemplate":"https://s.example/?q=%s"}"#,
        )
        .unwrap();
        assert_eq!(s.open_links_in, settings::LinksTarget::Pane);
        let s: settings::BrowserSettings =
            serde_json::from_str(r#"{"openLinksIn":"elsewhere"}"#).unwrap();
        assert_eq!(s, settings::BrowserSettings::default());
        assert_eq!(
            serde_json::to_value(settings::BrowserSettings::default()).unwrap(),
            serde_json::json!({"openLinksIn": "system", "searchTemplate": ""})
        );
    }
}
