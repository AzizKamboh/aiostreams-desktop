//! AIOStreams Integrated: updates of the whole integrated app (native client,
//! bundled Node server, interfaces and runtimes) from this repository's own
//! Velopack feeds. `main.rs` compiles this file in place of upstream's
//! `updates.rs`, which is kept unchanged so upstream merges stay clean; the
//! public API (`Updater`, `Command`) is the same.
//!
//! Differences from upstream's updater:
//! - feeds are `updates-stable` / `updates-preview` releases of the integrated
//!   repository, never upstream's client-only packages, and an offer of any
//!   other package ID is refused before downloading;
//! - upstream's "nightly" setting selects the integrated Preview channel;
//! - failed checks back off exponentially, downloads are retried a few times;
//! - installing never interrupts playback by itself: a downloaded update is
//!   applied when the app is closed, or at once when the user asks, after the
//!   normal shutdown has stopped the local server;
//! - detailed state (progress, times, errors) for Settings, read by the page
//!   with `integrated-update-*` messages through `embedded.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aiostreams_desktop_core::bridge::{Outbound, UpdateChannel};
use aiostreams_desktop_core::playback::PlayerState;
use serde::Serialize;
use serde_json::Value;
use velopack::locator::{LocationContext, auto_locate_app_manifest};
use velopack::sources::HttpSource;
use velopack::{UpdateCheck, UpdateInfo, UpdateManager, UpdateOptions};

use crate::update_policy::{self as policy, Channel};

/// `owner/name` compiled in by `package-windows.ps1 -UpdateRepository`.
const COMPILED_REPOSITORY: Option<&str> = option_env!("AIOSTREAMS_INTEGRATED_UPDATE_REPOSITORY");
/// Checks requested by the page more often than this only report the state.
const PAGE_CHECK_INTERVAL: Duration = Duration::from_secs(60);

pub enum Command {
    /// `None` keeps the channel this copy was installed from.
    Check(Option<UpdateChannel>),
    Apply,
}

enum Message {
    Check { channel: Option<Channel>, manual: bool },
}

pub struct Updater {
    commands: Sender<Message>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    /// `off`, `idle`, `checking`, `downloading`, `ready`, `current` or `error`.
    pub state: &'static str,
    pub off_reason: Option<String>,
    pub channel: Option<&'static str>,
    pub installed_channel: Option<&'static str>,
    pub installed_version: Option<String>,
    pub portable: bool,
    pub feed: Option<String>,
    pub latest_version: Option<String>,
    pub ready_version: Option<String>,
    pub progress: Option<i16>,
    pub release_notes_url: Option<String>,
    pub last_check: Option<u64>,
    pub last_success: Option<u64>,
    pub next_check: Option<u64>,
    pub last_error: Option<String>,
    pub failures: u32,
    /// Feed checks made since the app started; rises with every real check.
    pub checks: u64,
    pub playing: bool,
    /// A downloaded update installs when the app closes.
    pub install_on_exit: bool,
}

/// What to do with a downloaded update when the app exits.
struct Pending {
    manager: UpdateManager,
    info: UpdateInfo,
    restart: bool,
}

#[derive(Default)]
struct Shared {
    details: Mutex<Details>,
    pending: Mutex<Option<Pending>>,
    playing: AtomicBool,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

fn shared() -> &'static Shared {
    SHARED.get_or_init(|| Shared {
        details: Mutex::new(Details {
            state: "off",
            off_reason: Some("not started".into()),
            ..Default::default()
        }),
        ..Default::default()
    })
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn details(update: impl FnOnce(&mut Details)) {
    if let Ok(mut d) = shared().details.lock() {
        update(&mut d);
    }
}

fn off(reason: impl Into<String>) {
    let reason = reason.into();
    log::info!("updates off: {reason}");
    details(|d| {
        d.state = "off";
        d.off_reason = Some(reason);
    });
}

fn to_bridge(channel: Channel) -> UpdateChannel {
    match channel {
        Channel::Stable => UpdateChannel::Stable,
        Channel::Preview => UpdateChannel::Nightly,
    }
}

fn from_bridge(channel: UpdateChannel) -> Channel {
    match channel {
        UpdateChannel::Stable => Channel::Stable,
        UpdateChannel::Nightly => Channel::Preview,
    }
}

/// The feed for a channel; `AIOSTREAMS_UPDATE_FEED` overrides it for tests.
fn feed(repository: &str, channel: Channel) -> Result<String, String> {
    match std::env::var("AIOSTREAMS_UPDATE_FEED") {
        Ok(url) if policy::override_allowed(&url) => Ok(url),
        Ok(_) => Err("AIOSTREAMS_UPDATE_FEED must be HTTPS, loopback or a local folder".into()),
        Err(_) => Ok(policy::feed_url(repository, channel)),
    }
}

impl Updater {
    /// Nothing to update in a build Velopack did not pack, such as `cargo run`.
    pub fn start(emit: impl Fn(Outbound) + Send + 'static) -> Option<Updater> {
        let repository = match policy::repository(COMPILED_REPOSITORY) {
            Ok(repository) => repository.to_owned(),
            Err(e) => {
                off(e);
                return None;
            }
        };
        let locator = match auto_locate_app_manifest(LocationContext::FromCurrentExe) {
            Ok(locator) => locator,
            Err(e) => {
                off(format!("not installed or packed by Velopack ({e})"));
                return None;
            }
        };
        if locator.get_manifest_id() != policy::PACKAGE_ID {
            off(format!("package '{}' is not {}", locator.get_manifest_id(), policy::PACKAGE_ID));
            return None;
        }
        let Some(installed) = Channel::from_velopack(&locator.get_manifest_channel()) else {
            off(format!("channel '{}' has no integrated feed", locator.get_manifest_channel()));
            return None;
        };
        let version = locator.get_manifest_version_full_string();
        let portable = locator.get_is_portable();
        let packages = locator.get_packages_dir();
        details(|d| {
            *d = Details {
                state: "idle",
                channel: Some(installed.name()),
                installed_channel: Some(installed.name()),
                installed_version: Some(version.clone()),
                portable,
                feed: feed(&repository, installed).ok(),
                install_on_exit: true,
                ..Default::default()
            }
        });
        let (commands, received) = mpsc::channel();
        std::thread::Builder::new()
            .name("updates".into())
            .spawn(move || {
                let mut state = State {
                    repository,
                    installed,
                    version,
                    packages,
                    channel: installed,
                    failures: 0,
                    rate_limited: false,
                    attempts: (String::new(), 0),
                    last_check: None,
                    emit,
                };
                let mut wait = policy::FIRST_CHECK;
                loop {
                    details(|d| d.next_check = Some(now() + wait.as_secs()));
                    match received.recv_timeout(wait) {
                        Ok(Message::Check { channel, manual }) => state.check(channel, manual),
                        Err(RecvTimeoutError::Timeout) => state.check(None, false),
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    wait = policy::next_check(state.failures, state.rate_limited);
                }
            })
            .ok()?;
        let _ = UPDATER.set(Updater { commands: commands.clone() });
        Some(Updater { commands })
    }

    pub fn send(&self, command: Command) {
        match command {
            Command::Check(channel) => {
                let _ = self.commands.send(Message::Check {
                    channel: channel.map(from_bridge),
                    manual: false,
                });
            }
            // Restarting needs the shell's close path; see `apply`.
            Command::Apply => log::warn!("update apply without the shell; use updates::apply"),
        }
    }

    fn check_now(&self, manual: bool) {
        let _ = self.commands.send(Message::Check { channel: None, manual });
    }
}

struct State<E> {
    repository: String,
    installed: Channel,
    version: String,
    packages: std::path::PathBuf,
    channel: Channel,
    failures: u32,
    rate_limited: bool,
    /// Automatic download attempts of one version.
    attempts: (String, u32),
    last_check: Option<Instant>,
    emit: E,
}

impl<E: Fn(Outbound)> State<E> {
    fn report(&self, state: &'static str, version: Option<String>, error: Option<String>) {
        details(|d| {
            d.state = state;
            d.channel = Some(self.channel.name());
            if state != "downloading" {
                d.progress = None;
            }
            if error.is_some() {
                d.last_error = error.clone();
            }
            d.failures = self.failures;
            d.playing = shared().playing.load(Ordering::Relaxed);
        });
        (self.emit)(Outbound::UpdateState {
            state,
            channel: Some(to_bridge(self.channel)),
            version,
            error,
        });
    }

    fn manager(&self) -> Result<UpdateManager, String> {
        let options = UpdateOptions {
            ExplicitChannel: Some(self.channel.velopack().into()),
            // Never downgrade: a newer release may have migrated the database.
            AllowVersionDowngrade: false,
            ..Default::default()
        };
        let feed = feed(&self.repository, self.channel)?;
        details(|d| d.feed = Some(feed.clone()));
        UpdateManager::new(HttpSource::new(feed), Some(options), None).map_err(|e| e.to_string())
    }

    fn check(&mut self, channel: Option<Channel>, manual: bool) {
        let switched = channel.is_some_and(|c| c != self.channel);
        if let Some(channel) = channel {
            self.channel = channel;
        }
        if switched {
            log::info!("update channel {} (installed {})", self.channel.name(), self.installed.name());
            if let Ok(mut pending) = shared().pending.lock() {
                *pending = None;
            }
            details(|d| d.ready_version = None);
        }
        if manual {
            self.failures = 0;
            self.attempts.1 = 0;
        }
        let ready = shared()
            .pending
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.info.TargetFullRelease.Version.clone()));
        if let Some(version) = ready {
            return self.report("ready", Some(version), None);
        }
        // Page reloads ask too; within a minute of the last check just say where things are.
        if !manual && !switched && self.last_check.is_some_and(|at| at.elapsed() < PAGE_CHECK_INTERVAL) {
            let d = shared().details.lock().map(|d| (d.state, d.latest_version.clone())).ok();
            if let Some((state, version)) = d {
                return self.report(state, version, None);
            }
        }
        self.last_check = Some(Instant::now());
        details(|d| {
            d.last_check = Some(now());
            d.checks += 1;
        });
        self.report("checking", None, None);
        let found = self.manager().and_then(|manager| {
            let check = manager.check_for_updates().map_err(|e| e.to_string())?;
            Ok((manager, check))
        });
        match found {
            Ok((manager, UpdateCheck::UpdateAvailable(info))) => self.offer(manager, *info, manual),
            Ok(_) => {
                self.succeeded();
                details(|d| d.latest_version = Some(self.version.clone()));
                self.report("current", None, None);
            }
            Err(e) => self.fail(e),
        }
    }

    fn offer(&mut self, manager: UpdateManager, info: UpdateInfo, manual: bool) {
        let target = &info.TargetFullRelease;
        let version = target.Version.clone();
        if let Err(e) = policy::check_offer(
            &target.PackageId,
            &version,
            info.DeltasToTarget.iter().map(|d| d.PackageId.as_str()),
            &self.version,
        ) {
            // A wrong feed is not a network hiccup: say so, never download it.
            log::error!("update refused: {e}");
            return self.fail(format!("refused: {e}"));
        }
        self.succeeded();
        details(|d| {
            d.latest_version = Some(version.clone());
            d.release_notes_url = Some(policy::release_notes_url(&self.repository, &version));
        });
        if self.attempts.0 != version {
            self.attempts = (version.clone(), 0);
        }
        if !manual && self.attempts.1 >= policy::MAX_DOWNLOAD_ATTEMPTS {
            return self.report(
                "error",
                Some(version),
                Some("the download failed several times; choose Retry to try again".into()),
            );
        }
        if let Some(free) = free_space(&self.packages)
            && !policy::enough_disk(free, target.Size)
        {
            return self.report(
                "error",
                Some(version),
                Some(format!("not enough disk space for the update ({} MB needed)", target.Size * 3 / 1_048_576 + 300)),
            );
        }
        self.attempts.1 += 1;
        log::info!("update found version={version} channel={}", self.channel.name());
        self.report("downloading", Some(version.clone()), None);
        let (progress, updates) = mpsc::channel::<i16>();
        let reader = std::thread::spawn(move || {
            for percent in updates {
                details(|d| d.progress = Some(percent));
            }
        });
        // Velopack verifies the package's SHA checksum from the feed before keeping it.
        let downloaded = manager.download_updates(&info, Some(progress));
        let _ = reader.join();
        match downloaded {
            Ok(()) => {
                log::info!("update downloaded version={version}");
                details(|d| {
                    d.ready_version = Some(version.clone());
                    d.last_error = None;
                });
                if let Ok(mut pending) = shared().pending.lock() {
                    *pending = Some(Pending { manager, info, restart: false });
                }
                self.report("ready", Some(version), None);
            }
            Err(e) => self.fail(format!("download failed: {e}")),
        }
    }

    fn succeeded(&mut self) {
        self.failures = 0;
        self.rate_limited = false;
        details(|d| {
            d.last_success = Some(now());
            d.last_error = None;
        });
    }

    fn fail(&mut self, error: String) {
        self.failures += 1;
        self.rate_limited = policy::rate_limited(&error);
        log::warn!("update failed: {error}");
        self.report("error", None, Some(error));
    }
}

#[cfg(windows)]
fn free_space(dir: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // The packages folder may not exist yet; its parent is on the same volume.
    let existing = dir.ancestors().find(|p| p.exists())?;
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    // SAFETY: a NUL-terminated path and a valid out pointer; the others may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_space(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// Called with every player state: an update never restarts the app mid-file.
pub fn observe_player(state: &PlayerState) {
    if let Some(idle) = state.idle {
        shared().playing.store(!idle, Ordering::Relaxed);
    }
}

/// Upstream's "Restart now" and the integrated "Install and restart": both are
/// explicit requests. The app then closes through its normal path, which stops
/// the local server gracefully; `on_exit` starts Velopack, which waits for this
/// process to end, installs and starts the new version.
pub fn apply(send: &dyn Fn(crate::UserEvent)) -> bool {
    let armed = match shared().pending.lock() {
        Ok(mut pending) => match pending.as_mut() {
            Some(pending) => {
                pending.restart = true;
                true
            }
            None => false,
        },
        Err(_) => false,
    };
    if armed {
        log::info!("closing to install the downloaded update");
        send(crate::UserEvent::Close);
    }
    armed
}

/// Runs on the shell's close path after the local server has stopped. A
/// downloaded update installs silently after exit, and restarts the app only if
/// that was asked for. Failure leaves the current version in place.
pub fn on_exit() {
    let Some(pending) = shared().pending.lock().ok().and_then(|mut p| p.take()) else {
        return;
    };
    let version = &pending.info.TargetFullRelease.Version;
    log::info!("installing update version={version} restart={}", pending.restart);
    if let Err(e) = pending.manager.wait_exit_then_apply_updates(
        &pending.info.TargetFullRelease,
        true,
        pending.restart,
        Vec::<String>::new(),
    ) {
        log::warn!("could not start the update installer: {e}; the current version stays installed");
    }
}

/// `integrated-update-*` messages from the app's own page (origin already checked).
pub fn page_message(kind: &str, value: &Value, send: &dyn Fn(crate::UserEvent)) -> Value {
    match kind {
        "integrated-update-check" => {
            if let Some(updater) = UPDATER.get() {
                updater.check_now(true);
            }
        }
        "integrated-update-install" => {
            // The page asks first while something plays; without `confirmed` nothing restarts mid-file.
            let playing = shared().playing.load(Ordering::Relaxed);
            if playing && value["confirmed"].as_bool() != Some(true) {
                return status_with(Some("playing"));
            }
            if !apply(send) {
                return status_with(Some("nothing-ready"));
            }
        }
        _ => {}
    }
    status_with(None)
}

fn status_with(refused: Option<&str>) -> Value {
    let mut d = shared().details.lock().map(|d| d.clone()).unwrap_or_default();
    d.playing = shared().playing.load(Ordering::Relaxed);
    let mut value = serde_json::to_value(d).unwrap_or_default();
    value["type"] = "integrated-update-state".into();
    value["integratedVersion"] = crate::INTEGRATED_VERSION.into();
    if let Some(refused) = refused {
        value["refused"] = refused.into();
    }
    value
}

/// A second sender, so `page_message` reaches the updater the shell owns.
static UPDATER: OnceLock<Updater> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_nightly_selects_the_integrated_preview_channel() {
        assert_eq!(from_bridge(UpdateChannel::Nightly), Channel::Preview);
        assert_eq!(to_bridge(Channel::Preview), UpdateChannel::Nightly);
        assert_eq!(from_bridge(to_bridge(Channel::Stable)), Channel::Stable);
    }

    #[test]
    fn a_copy_velopack_did_not_install_reports_updates_off() {
        // `cargo test` runs outside any Velopack install.
        let updater = Updater::start(|_| {});
        assert!(updater.is_none());
        let status = status_with(None);
        assert_eq!(status["type"], "integrated-update-state");
        assert_eq!(status["state"], "off");
        assert!(status["offReason"].as_str().is_some());
    }

    #[test]
    fn install_requests_during_playback_need_confirmation_and_nothing_restarts_without_an_update() {
        shared().playing.store(true, Ordering::Relaxed);
        let closed = std::cell::Cell::new(false);
        let send = |event: crate::UserEvent| closed.set(matches!(event, crate::UserEvent::Close));
        let reply = page_message("integrated-update-install", &serde_json::json!({}), &send);
        assert_eq!(reply["refused"], "playing");
        let reply = page_message("integrated-update-install", &serde_json::json!({ "confirmed": true }), &send);
        assert_eq!(reply["refused"], "nothing-ready");
        assert!(!closed.get());
        shared().playing.store(false, Ordering::Relaxed);
        on_exit(); // nothing pending: must not panic or start anything
    }

    #[test]
    fn test_feed_overrides_reject_remote_plain_http() {
        // SAFETY: tests in this module do not read this variable concurrently.
        unsafe { std::env::set_var("AIOSTREAMS_UPDATE_FEED", "http://example.com/feed/") };
        assert!(feed("a/b", Channel::Stable).is_err());
        unsafe { std::env::set_var("AIOSTREAMS_UPDATE_FEED", "http://127.0.0.1:9/feed/") };
        assert_eq!(feed("a/b", Channel::Stable).unwrap(), "http://127.0.0.1:9/feed/");
        unsafe { std::env::remove_var("AIOSTREAMS_UPDATE_FEED") };
        assert!(feed("a/b", Channel::Preview).unwrap().ends_with("/updates-preview/"));
    }
}
