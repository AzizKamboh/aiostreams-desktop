//! AIOStreams Integrated: update rules that need no network or Velopack, so
//! they are unit-tested here and shared with `scripts/release/feed-check`.
//! Depends on `std` only.

use std::time::Duration;

/// The integrated package's Velopack identity. Never upstream's `aiostreams-desktop`.
pub const PACKAGE_ID: &str = "aiostreams-integrated";
/// Compiled-in GitHub repository whose `updates-<channel>` releases are the feed.
pub const DEFAULT_REPOSITORY: &str = "AzizKamboh/aiostreams-desktop";
/// Upstream's repository: its client-only packages would remove the bundled server.
pub const UPSTREAM_REPOSITORY: &str = "Viren070/AIOStreams";

pub const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// First automatic check after startup, so the check never competes with it.
pub const FIRST_CHECK: Duration = Duration::from_secs(45);
/// Automatic attempts to download one version before waiting for the user.
pub const MAX_DOWNLOAD_ATTEMPTS: u32 = 4;
const BACKOFF_BASE: Duration = Duration::from_secs(5 * 60);
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(60 * 60);
/// Room kept free besides the package itself: Velopack extracts it next to the old version.
const DISK_MARGIN: u64 = 300 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Preview,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Preview => "preview",
        }
    }

    /// The Velopack channel the package was packed with (`vpk pack --channel`).
    pub fn velopack(self) -> &'static str {
        match self {
            Channel::Stable => "win-x64",
            Channel::Preview => "win-x64-preview",
        }
    }

    /// The channel of an installed copy, from its Velopack manifest. Anything
    /// else (upstream's `win-x64-nightly`, a test build) gets no updates.
    pub fn from_velopack(channel: &str) -> Option<Channel> {
        match channel {
            "win-x64" => Some(Channel::Stable),
            "win-x64-preview" => Some(Channel::Preview),
            _ => None,
        }
    }
}

/// The repository compiled in by the packaging script, if it is a safe one.
pub fn repository(compiled: Option<&str>) -> Result<&str, String> {
    let repository = compiled.unwrap_or(DEFAULT_REPOSITORY);
    let valid = repository.split_once('/').is_some_and(|(owner, name)| {
        let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        ok(owner) && ok(name) && name != "." && name != ".."
    });
    if !valid {
        return Err(format!("invalid update repository '{repository}'"));
    }
    if repository.eq_ignore_ascii_case(UPSTREAM_REPOSITORY) {
        return Err("refusing upstream's client-only feed".into());
    }
    Ok(repository)
}

/// The Velopack HTTP feed (directory URL) of a channel.
pub fn feed_url(repository: &str, channel: Channel) -> String {
    format!("https://github.com/{repository}/releases/download/updates-{}/", channel.name())
}

pub fn release_notes_url(repository: &str, version: &str) -> String {
    format!("https://github.com/{repository}/releases/tag/v{version}")
}

/// A feed overridden for tests must be local or HTTPS, never plain remote HTTP.
pub fn override_allowed(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://127.0.0.1:")
        || lower.starts_with("http://localhost:")
        || (lower.len() > 2 && lower.as_bytes()[1] == b':' && lower.as_bytes()[0].is_ascii_alphabetic())
        || lower.starts_with("\\\\")
        || lower.starts_with('/')
}

/// What a feed's chosen update must satisfy before anything is downloaded.
/// Velopack itself verifies the package checksums, but not whose package it is.
pub fn check_offer<'a>(
    target_id: &str,
    target_version: &str,
    delta_ids: impl IntoIterator<Item = &'a str>,
    installed_version: &str,
) -> Result<(), String> {
    if target_id != PACKAGE_ID {
        return Err(format!("the feed offers package '{target_id}', not {PACKAGE_ID}"));
    }
    if let Some(other) = delta_ids.into_iter().find(|id| *id != PACKAGE_ID) {
        return Err(format!("the feed offers a delta of package '{other}', not {PACKAGE_ID}"));
    }
    match compare_versions(target_version, installed_version) {
        Some(std::cmp::Ordering::Greater) => Ok(()),
        Some(_) => Err(format!("the feed offers {target_version}, not newer than {installed_version}")),
        None => Err(format!("the feed offers an invalid version '{target_version}'")),
    }
}

/// SemVer 2.0 precedence; `None` for anything that is not SemVer.
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn parse(v: &str) -> Option<([u64; 3], Vec<&str>)> {
        let v = v.split('+').next()?;
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core, pre.split('.').collect()),
            None => (v, Vec::new()),
        };
        let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
        let numbers = [parts.next()??, parts.next()??, parts.next()??];
        if parts.next().is_some() || pre.iter().any(|p| p.is_empty()) {
            return None;
        }
        Some((numbers, pre))
    }
    let ((x, xp), (y, yp)) = (parse(a)?, parse(b)?);
    Some(x.cmp(&y).then_with(|| match (xp.is_empty(), yp.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (p, q) in xp.iter().zip(&yp) {
                let order = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(p), Ok(q)) => p.cmp(&q),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => p.cmp(q),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            xp.len().cmp(&yp.len())
        }
    }))
}

/// Space needed to download and install a package of `size` bytes.
pub fn enough_disk(free: u64, size: u64) -> bool {
    free >= size.saturating_mul(3).saturating_add(DISK_MARGIN)
}

/// GitHub answers too many anonymous requests with 403 or 429.
pub fn rate_limited(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("429") || e.contains("rate limit") || (e.contains("403") && e.contains("github"))
}

/// When to check again after `failures` consecutive failed checks.
pub fn next_check(failures: u32, rate_limited: bool) -> Duration {
    if failures == 0 {
        return RECHECK;
    }
    if rate_limited {
        return RATE_LIMIT_WAIT;
    }
    let factor = 1u32 << (failures - 1).min(7);
    (BACKOFF_BASE * factor).min(RECHECK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn channels_round_trip_and_unknown_channels_get_no_updates() {
        for channel in [Channel::Stable, Channel::Preview] {
            assert_eq!(Channel::from_velopack(channel.velopack()), Some(channel));
        }
        assert_eq!(Channel::from_velopack("win-x64-nightly"), None);
        assert_eq!(Channel::from_velopack("osx-arm64"), None);
        assert_eq!(Channel::from_velopack(""), None);
    }

    #[test]
    fn the_feed_is_this_repository_and_never_upstream() {
        assert_eq!(
            feed_url(repository(None).unwrap(), Channel::Stable),
            "https://github.com/AzizKamboh/aiostreams-desktop/releases/download/updates-stable/"
        );
        assert_eq!(
            feed_url("a/b", Channel::Preview),
            "https://github.com/a/b/releases/download/updates-preview/"
        );
        assert!(repository(Some("Viren070/AIOStreams")).is_err());
        assert!(repository(Some("viren070/aiostreams")).is_err());
        assert!(repository(Some("a/../b")).is_err());
        assert!(repository(Some("a")).is_err());
        assert!(repository(Some("a/b?x")).is_err());
        assert_eq!(repository(Some("fork-owner/aiostreams-desktop")), Ok("fork-owner/aiostreams-desktop"));
    }

    #[test]
    fn overrides_must_be_local_or_https() {
        assert!(override_allowed("http://127.0.0.1:8080/feed/"));
        assert!(override_allowed("https://example.com/feed/"));
        assert!(override_allowed("C:\\feeds\\local"));
        assert!(!override_allowed("http://example.com/feed/"));
        assert!(!override_allowed("ftp://example.com/"));
    }

    #[test]
    fn offers_of_another_package_or_older_version_are_refused() {
        assert!(check_offer(PACKAGE_ID, "0.3.0", [], "0.2.2").is_ok());
        assert!(check_offer(PACKAGE_ID, "0.3.0", [PACKAGE_ID], "0.3.0-preview.2").is_ok());
        assert!(check_offer("aiostreams-desktop", "9.0.0", [], "0.2.2").is_err());
        assert!(check_offer(PACKAGE_ID, "0.3.0", ["aiostreams-desktop"], "0.2.2").is_err());
        assert!(check_offer(PACKAGE_ID, "0.2.2", [], "0.2.2").is_err());
        assert!(check_offer(PACKAGE_ID, "0.2.1", [], "0.2.2").is_err());
        assert!(check_offer(PACKAGE_ID, "latest", [], "0.2.2").is_err());
    }

    #[test]
    fn semver_precedence() {
        assert_eq!(compare_versions("0.3.0", "0.2.9"), Some(Greater));
        assert_eq!(compare_versions("0.3.0-preview.2", "0.3.0"), Some(Less));
        assert_eq!(compare_versions("0.3.0-preview.10", "0.3.0-preview.9"), Some(Greater));
        assert_eq!(compare_versions("0.10.0", "0.9.0"), Some(Greater));
        assert_eq!(compare_versions("1.0.0+build", "1.0.0"), Some(Equal));
        assert_eq!(compare_versions("1.0", "1.0.0"), None);
        assert_eq!(compare_versions("1.0.0-", "1.0.0"), None);
    }

    #[test]
    fn disk_space_needs_the_package_three_times_plus_a_margin() {
        let mb = 1024 * 1024;
        assert!(enough_disk(1000 * mb, 200 * mb));
        assert!(!enough_disk(800 * mb, 200 * mb));
        assert!(!enough_disk(0, 1));
    }

    #[test]
    fn failed_checks_back_off_exponentially_but_never_beyond_the_normal_interval() {
        assert_eq!(next_check(0, false), RECHECK);
        assert_eq!(next_check(1, false), Duration::from_secs(300));
        assert_eq!(next_check(2, false), Duration::from_secs(600));
        assert_eq!(next_check(4, false), Duration::from_secs(2400));
        assert_eq!(next_check(30, false), RECHECK);
        assert_eq!(next_check(1, true), Duration::from_secs(3600));
        assert!(rate_limited("HTTP 429 Too Many Requests"));
        assert!(rate_limited("403 Forbidden from github.com: API rate limit exceeded"));
        assert!(!rate_limited("connection refused"));
    }
}
