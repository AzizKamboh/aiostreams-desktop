//! AIOStreams Integrated: the user's AIOStreams accounts.
//!
//! These are exactly what a Docker install puts in `AIOSTREAMS_AUTH` and
//! `AIOSTREAMS_AUTH_PERMISSIONS`. They are stored with DPAPI beside the server
//! key, handed to Node as those two environment variables at every start (never
//! on the command line), and checked against the running server with the same
//! test the built-in Usenet service applies before it streams.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::secure;

/// Upstream's permission names (`packages/core/src/utils/permissions.ts`).
pub const PERMISSIONS: [&str; 6] = [
    "admin",
    "proxy",
    "service",
    "sabnzbd",
    "webdav",
    "createConfig",
];
/// The shell's own dashboard account, appended by `desktop-env.ts`.
pub const RESERVED_USER: &str = "desktop";
const MAX_ACCOUNTS: usize = 32;

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    pub password: String,
    /// Empty means upstream's `none`: may sign in, holds no permission.
    pub permissions: Vec<String>,
}

pub fn path(root: &Path) -> PathBuf {
    root.join("accounts.protected")
}

/// A missing file is a profile that has not set up an account yet.
pub fn load(root: &Path) -> Result<Vec<Account>, String> {
    let file = path(root);
    if !file.exists() {
        return Ok(Vec::new());
    }
    let accounts: Vec<Account> = serde_json::from_slice(&secure::read(&file)?)
        .map_err(|_| "The saved AIOStreams accounts are damaged".to_string())?;
    validate(&accounts)?;
    Ok(accounts)
}

pub fn save(root: &Path, accounts: &[Account]) -> Result<(), String> {
    validate(accounts)?;
    let bytes = serde_json::to_vec(accounts).map_err(|_| "Could not encode the accounts")?;
    secure::write(&path(root), &bytes)
}

/// Parse the setup screen's `accounts` array.
pub fn parse(value: &Value) -> Result<Vec<Account>, String> {
    let accounts: Vec<Account> = serde_json::from_value(value.clone())
        .map_err(|_| "The account details are incomplete".to_string())?;
    validate(&accounts)?;
    Ok(accounts)
}

/// Upstream's own parsing rules for the two variables (`env.ts`), so a saved
/// account can never stop the backend from starting.
pub fn validate(accounts: &[Account]) -> Result<(), String> {
    if accounts.len() > MAX_ACCOUNTS {
        return Err(format!("At most {MAX_ACCOUNTS} accounts are supported"));
    }
    let mut seen = std::collections::HashSet::new();
    for account in accounts {
        let name = &account.username;
        if name.is_empty() {
            return Err("A username cannot be empty".into());
        }
        if name.trim() != name {
            return Err(format!(
                "Username \"{name}\" cannot start or end with a space"
            ));
        }
        if name.len() > 128 || name.chars().any(|c| c.is_control()) {
            return Err(format!(
                "Username \"{name}\" is too long or has invalid characters"
            ));
        }
        if let Some(c) = name.chars().find(|c| matches!(c, ':' | ',' | '=')) {
            return Err(format!("Usernames cannot contain '{c}'"));
        }
        if name == RESERVED_USER {
            return Err("The username \"desktop\" is reserved by the app".into());
        }
        if !seen.insert(name.as_str()) {
            return Err(format!("The username \"{name}\" is used twice"));
        }
        let password = &account.password;
        if password.is_empty() {
            return Err(format!("The password for \"{name}\" cannot be empty"));
        }
        if password.trim() != password {
            return Err(format!(
                "The password for \"{name}\" cannot start or end with a space"
            ));
        }
        if password.len() > 256 || password.chars().any(|c| c.is_control()) {
            return Err(format!(
                "The password for \"{name}\" is too long or has invalid characters"
            ));
        }
        if password.contains(',') {
            return Err(format!("The password for \"{name}\" cannot contain ','"));
        }
        for permission in &account.permissions {
            if !PERMISSIONS.contains(&permission.as_str()) {
                return Err(format!("Unknown permission \"{permission}\""));
            }
        }
    }
    Ok(())
}

/// `AIOSTREAMS_AUTH` and `AIOSTREAMS_AUTH_PERMISSIONS`, or None without accounts.
pub fn environment(accounts: &[Account]) -> Option<(String, String)> {
    if accounts.is_empty() {
        return None;
    }
    let auth = accounts
        .iter()
        .map(|a| format!("{}:{}", a.username, a.password))
        .collect::<Vec<_>>()
        .join(",");
    let permissions = accounts
        .iter()
        .map(|a| {
            let mut list: Vec<&str> = PERMISSIONS
                .iter()
                .copied()
                .filter(|p| a.permissions.iter().any(|q| q == p))
                .collect();
            if list.is_empty() {
                list.push("none");
            }
            format!("{}={}", a.username, list.join("|"))
        })
        .collect::<Vec<_>>()
        .join(",");
    Some((auth, permissions))
}

/// What the client may see: never a password.
pub fn summary(accounts: &[Account], checks: Option<&[Result<(), String>]>) -> Value {
    Value::Array(
        accounts
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let check = checks.and_then(|c| c.get(i));
                json!({
                    "username": a.username,
                    "permissions": a.permissions,
                    "usenet": check.map(|c| c.is_ok()),
                    "detail": check.and_then(|c| c.as_ref().err()),
                })
            })
            .collect(),
    )
}

/// Ask the running server whether this credential passes the built-in Usenet
/// service's check (`/__desktop/account-check`, see desktop-routes.ts).
pub fn check(port: u16, token: &str, account: &Account) -> Result<(), String> {
    let body =
        json!({ "credential": format!("{}:{}", account.username, account.password) }).to_string();
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "The local server did not answer the account check".to_string())?;
    let timeout = Some(Duration::from_secs(5));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    write!(
        stream,
        "POST /__desktop/account-check HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-AIOStreams-Desktop-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|_| "Could not send the account check".to_string())?;
    let mut response = Vec::new();
    let _ = stream.take(16 * 1024).read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response);
    let json = text
        .split_once("\r\n\r\n")
        .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .ok_or_else(|| "The local server gave an unreadable account check".to_string())?;
    if json["success"] == true {
        Ok(())
    } else {
        Err(json["detail"]
            .as_str()
            .unwrap_or("The server rejected this account")
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(username: &str, password: &str, permissions: &[&str]) -> Account {
        Account {
            username: username.into(),
            password: password.into(),
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn follows_upstream_parsing_rules() {
        assert!(validate(&[account("aziz", "p:a=s|s word", &["admin"])]).is_ok());
        for bad in [
            account("", "x", &[]),
            account(" aziz", "x", &[]),
            account("a:b", "x", &[]),
            account("a,b", "x", &[]),
            account("a=b", "x", &[]),
            account("desktop", "x", &[]),
            account("aziz", "", &[]),
            account("aziz", "has,comma", &[]),
            account("aziz", " padded", &[]),
            account("aziz", "line\nbreak", &[]),
            account("aziz", "x", &["superuser"]),
        ] {
            assert!(validate(&[bad]).is_err());
        }
        assert!(validate(&[account("a", "x", &[]), account("a", "y", &[])]).is_err());
    }

    #[test]
    fn writes_the_upstream_environment_format() {
        let (auth, permissions) = environment(&[
            account("aziz", "secret:1", &["service", "admin"]),
            account("guest", "pw", &[]),
        ])
        .unwrap();
        assert_eq!(auth, "aziz:secret:1,guest:pw");
        assert_eq!(permissions, "aziz=admin|service,guest=none");
        assert!(environment(&[]).is_none());
    }

    #[test]
    fn summary_never_contains_passwords() {
        let text = summary(&[account("aziz", "very-secret", &["admin"])], None).to_string();
        assert!(text.contains("aziz") && !text.contains("very-secret"));
    }
}
