//! The private, per-user server. Installed files are read-only; state lives beside
//! the WebView profile. No shell is involved in launching or shutting it down.

#[path = "backend/accounts.rs"]
mod accounts;
#[path = "backend/secure.rs"]
mod secure;
#[cfg(windows)]
#[path = "backend/windows_job.rs"]
mod windows_job;

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const START_TIMEOUT: Duration = Duration::from_secs(240);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const STORAGE_LIMIT: usize = 4 * 1024 * 1024;
/// How long the just-created credential stays available for the copy step.
const NEW_CREDENTIAL_TTL: Duration = Duration::from_secs(15 * 60);

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

enum Control {
    Restart,
    Stop,
}

struct State {
    phase: &'static str,
    message: String,
    url: Option<String>,
    token: String,
    storage: Value,
    storage_writable: bool,
    owned_origins: Vec<String>,
    /// Usernames, permissions and the latest Usenet check; never passwords.
    accounts: Value,
    /// Set when saved accounts exist but cannot be read; saving is then refused.
    accounts_error: Option<String>,
    /// The primary credential the user just saved, for the setup screen's copy
    /// step after the restart. Memory only; cleared when acknowledged.
    new_credential: Option<(String, Instant)>,
}

/// Held by the native shell, never by the worker it owns.
pub struct Backend {
    commands: mpsc::Sender<Control>,
    worker: Mutex<Option<JoinHandle<()>>>,
    state: Arc<Mutex<State>>,
    storage_path: PathBuf,
    root: PathBuf,
}

impl Backend {
    pub fn start(data_dir: PathBuf, emit: impl Fn(Value) + Send + Sync + 'static) -> Arc<Self> {
        let root = data_dir.join("backend");
        let storage_path = root.join("client-storage.protected");
        let stored = secure::read(&storage_path).and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| "Saved client settings are not valid JSON".into())
        });
        let (storage, storage_error) = match stored {
            Ok(value) if valid_storage(&value) => (value, None),
            Ok(_) => (
                json!({}),
                Some("Saved client settings have an invalid format".to_string()),
            ),
            Err(_) if !storage_path.exists() => (json!({}), None),
            Err(error) => (json!({}), Some(error)),
        };
        let (saved_accounts, accounts_error) = match accounts::load(&root) {
            Ok(saved) => (accounts::summary(&saved, None), None),
            Err(error) => (json!([]), Some(error)),
        };
        let state = Arc::new(Mutex::new(State {
            phase: "starting",
            message: "Starting the local AIOStreams server…".into(),
            url: None,
            token: String::new(),
            storage,
            storage_writable: storage_error.is_none(),
            owned_origins: Vec::new(),
            accounts: saved_accounts,
            accounts_error,
            new_credential: None,
        }));
        let (commands, received) = mpsc::channel();
        let shared = state.clone();
        let emit: Emit = Arc::new(emit);
        let worker_root = root.clone();
        let worker = thread::Builder::new()
            .name("embedded-backend".into())
            .spawn(move || {
                if let Some(error) = storage_error {
                    report(&shared, &emit, "failed", &error, None);
                    return;
                }
                run(worker_root, received, shared, emit);
            });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(_) => {
                let mut s = state.lock().unwrap();
                s.phase = "failed";
                s.message = "Windows could not start the backend supervisor thread".into();
                None
            }
        };
        Arc::new(Self {
            commands,
            worker: Mutex::new(worker),
            state,
            storage_path,
            root,
        })
    }

    /// Save the setup screen's accounts, then restart the backend so upstream
    /// reads them from AIOSTREAMS_AUTH. Existing accounts are only replaced when
    /// the request says so explicitly, and unreadable ones never are.
    pub fn save_accounts(&self, request: &Value) -> Result<(), String> {
        // `keep` with an empty password keeps that user's saved password, so
        // permissions can change without retyping every password.
        let saved = accounts::load(&self.root).unwrap_or_default();
        let mut entries = request["accounts"].clone();
        let typed: Vec<String> = entries
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["password"].as_str().is_some_and(|p| !p.is_empty()))
            .filter_map(|e| e["username"].as_str().map(str::to_owned))
            .collect();
        for entry in entries.as_array_mut().into_iter().flatten() {
            if entry["keep"] == true && entry["password"].as_str() == Some("") {
                let previous = saved
                    .iter()
                    .find(|a| Some(a.username.as_str()) == entry["username"].as_str());
                match previous {
                    Some(previous) => entry["password"] = json!(previous.password),
                    None => {
                        return Err("A kept account no longer exists; reload and try again".into());
                    }
                }
            }
        }
        let new = accounts::parse(&entries)?;
        if new.is_empty() {
            return Err("Add at least one account".into());
        }
        {
            let mut state = self.state.lock().map_err(|_| "Accounts are unavailable")?;
            if let Some(error) = &state.accounts_error {
                return Err(format!(
                    "{error}. Refusing to overwrite them; restore the backend data backup or use the original Windows user."
                ));
            }
            let existing = state.accounts.as_array().is_some_and(|a| !a.is_empty());
            if existing && request["replace"] != true {
                return Err("Confirm replacing the existing accounts".into());
            }
            accounts::save(&self.root, &new)?;
            state.accounts = accounts::summary(&new, None);
            // Offer the copy step only for an account whose password was typed now.
            state.new_credential = new
                .iter()
                .find(|a| typed.contains(&a.username))
                .map(|a| (format!("{}:{}", a.username, a.password), Instant::now()));
        }
        log::info!(
            "embedded backend: saved {} AIOStreams account(s)",
            new.len()
        );
        self.restart();
        Ok(())
    }

    /// The setup screen has shown the new credential; forget it.
    pub fn forget_new_credential(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.new_credential = None;
        }
    }

    pub fn status(&self) -> Value {
        snapshot(&self.state)
    }

    /// Reject unknown value types and oversized input before touching persistent data.
    pub fn save_storage(&self, value: Value) -> Result<(), String> {
        if !valid_storage(&value) {
            return Err("Client storage must contain bounded string values".into());
        }
        let bytes = serde_json::to_vec(&value).map_err(|_| "Could not encode client settings")?;
        if bytes.len() > STORAGE_LIMIT {
            return Err("Client settings exceed the 4 MB limit".into());
        }
        // Serializes disk writes and publication, so a late write cannot undo a newer one.
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Client settings are unavailable")?;
        if !state.storage_writable {
            return Err(
                "Saved client settings could not be unlocked; refusing to overwrite them".into(),
            );
        }
        secure::write(&self.storage_path, &bytes)?;
        state.storage = value;
        Ok(())
    }

    pub fn restart(&self) {
        let _ = self.commands.send(Control::Restart);
    }

    /// Explicitly called on window close. Drop is a second line of defence.
    pub fn stop(&self) {
        let _ = self.commands.send(Control::Stop);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    pub fn is_origin(&self, candidate: &str) -> bool {
        let state = self.state.lock().unwrap();
        state
            .url
            .as_ref()
            .is_some_and(|url| local_url(candidate, url))
    }

    /// Used only by native navigation; never included in diagnostics or persisted.
    pub fn bootstrap_url(&self) -> Option<String> {
        let s = self.state.lock().unwrap();
        (s.phase == "ready")
            .then(|| {
                s.url
                    .as_ref()
                    .map(|url| format!("{url}/__desktop/session?__desktop_token={}", s.token))
            })
            .flatten()
    }

    /// A query capability is not carried to an external HTTP redirect, unlike an
    /// arbitrary Authorization/header field. Only the owned loopback origin gets it.
    pub fn media_url(&self, candidate: &str) -> String {
        let s = self.state.lock().unwrap();
        let Some(current) = s.url.as_ref() else {
            return candidate.to_string();
        };
        let Some(previous) = std::iter::once(current)
            .chain(s.owned_origins.iter())
            .find(|base| local_url(candidate, base))
        else {
            return candidate.to_string();
        };
        let rebased = format!("{current}{}", &candidate[previous.len()..]);
        let candidate = rebased.as_str();
        let (without_fragment, fragment) = candidate
            .split_once('#')
            .map_or((candidate, ""), |(a, b)| (a, b));
        let (path, query) = without_fragment
            .split_once('?')
            .unwrap_or((without_fragment, ""));
        let mut fields: Vec<&str> = query
            .split('&')
            .filter(|p| p.split('=').next() != Some("__desktop_token"))
            .collect();
        if query.is_empty() {
            fields.clear();
        }
        let auth = format!("__desktop_token={}", s.token);
        fields.push(&auth);
        format!(
            "{path}?{}{}{}",
            fields.join("&"),
            if fragment.is_empty() { "" } else { "#" },
            fragment
        )
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn valid_storage(value: &Value) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() <= 4096 && map.iter().all(|(k, v)| k.len() <= 1024 && v.is_string())
    })
}

fn local_url(candidate: &str, base: &str) -> bool {
    candidate.strip_prefix(base).is_some_and(|rest| {
        rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#')
    })
}

fn valid_owned_origin(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|port| port.parse::<u16>().ok())
        .is_some_and(|port| port >= 1024 && url == format!("http://127.0.0.1:{port}"))
}

fn remember_origin(origins: &mut Vec<String>, origin: &str) {
    origins.retain(|saved| saved != origin);
    origins.push(origin.to_string());
    if origins.len() > 128 {
        origins.remove(0);
    }
}

fn snapshot(state: &Mutex<State>) -> Value {
    let mut s = state.lock().unwrap();
    if s.new_credential
        .as_ref()
        .is_some_and(|(_, at)| at.elapsed() > NEW_CREDENTIAL_TTL)
    {
        s.new_credential = None;
    }
    json!({
        "type": "backend-state",
        "state": s.phase,
        "message": s.message,
        "url": s.url,
        "storage": s.storage,
        "accounts": s.accounts,
        "accountsError": s.accounts_error,
        "newCredential": s.new_credential.as_ref().map(|(c, _)| c),
    })
}

fn report(
    state: &Mutex<State>,
    emit: &Emit,
    phase: &'static str,
    message: &str,
    url: Option<String>,
) {
    {
        let mut s = state.lock().unwrap();
        s.phase = phase;
        s.message = message.into();
        s.url = url;
    }
    log::info!("embedded backend: {phase}: {message}");
    emit(snapshot(state));
}

fn run(root: PathBuf, received: mpsc::Receiver<Control>, state: Arc<Mutex<State>>, emit: Emit) {
    let setup = (|| -> Result<_, String> {
        secure::directory(&root)?;
        secure::directory(&root.join("data"))?;
        let key_file = root.join("server-key.protected");
        let key = if key_file.exists() {
            let bytes = secure::read(&key_file)?;
            let key = String::from_utf8(bytes)
                .map_err(|_| "The saved server key is damaged; restore the backend data backup")?;
            if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(
                    "The saved server key is invalid; restore the backend data backup".into(),
                );
            }
            key
        } else {
            // Never silently replace a key next to an existing encrypted database.
            if root.join("data/db.sqlite").exists() {
                return Err("The server key is missing beside an existing database; restore server-key.protected from backup".into());
            }
            let key = secure::random_hex()?;
            secure::write(&key_file, key.as_bytes())?;
            key
        };
        let token = secure::random_hex()?;
        let aliases_file = root.join("owned-origins.protected");
        let mut aliases: Vec<String> = if aliases_file.exists() {
            serde_json::from_slice(&secure::read(&aliases_file)?)
                .map_err(|_| "The saved local-server address history is damaged")?
        } else {
            Vec::new()
        };
        if aliases.len() > 128 || aliases.iter().any(|url| !valid_owned_origin(url)) {
            return Err("The saved local-server address history is invalid".into());
        }
        let mut shared = state.lock().unwrap();
        if let Some(previous) = shared.storage["aiostreams-desktop-last-origin"]
            .as_str()
            .filter(|s| valid_owned_origin(s))
        {
            remember_origin(&mut aliases, previous);
        }
        if let Some(port) = fs::read_to_string(root.join("last-port"))
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
            .filter(|p| *p >= 1024)
        {
            remember_origin(&mut aliases, &format!("http://127.0.0.1:{port}"));
        }
        shared.token = token.clone();
        shared.owned_origins = aliases;
        Ok((key, token))
    })();
    let (key, token) = match setup {
        Ok(pair) => pair,
        Err(error) => {
            report(&state, &emit, "failed", &error, None);
            return;
        }
    };
    loop {
        report(
            &state,
            &emit,
            "starting",
            "Starting the local AIOStreams server…",
            None,
        );
        match launch(&root, &key, &token, &received, &state, &emit) {
            RunResult::Stop => {
                report(
                    &state,
                    &emit,
                    "stopped",
                    "The local server has stopped",
                    None,
                );
                return;
            }
            RunResult::Restart => continue,
            RunResult::Failed(message) => report(&state, &emit, "failed", &message, None),
        }
        match received.recv() {
            Ok(Control::Restart) => continue,
            _ => return,
        }
    }
}

enum RunResult {
    Stop,
    Restart,
    Failed(String),
}

fn launch(
    root: &Path,
    key: &str,
    token: &str,
    received: &mpsc::Receiver<Control>,
    state: &Mutex<State>,
    emit: &Emit,
) -> RunResult {
    for attempt in 0..3 {
        let port = match available_port(root, attempt == 0) {
            Ok(p) => p,
            Err(error) => return RunResult::Failed(error),
        };
        let url = format!("http://127.0.0.1:{port}");
        let mut process = match OwnedChild::start(root, port, key, token) {
            Ok(p) => p,
            Err(error) => return RunResult::Failed(error),
        };
        let deadline = Instant::now() + START_TIMEOUT;
        let mut ready = false;
        loop {
            match received.recv_timeout(Duration::from_millis(200)) {
                Ok(Control::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    process.stop();
                    return RunResult::Stop;
                }
                Ok(Control::Restart) => {
                    process.stop();
                    return RunResult::Restart;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            match process.child.try_wait() {
                Ok(Some(exit)) => {
                    // Exit can be observed before the pipe readers are scheduled.
                    // Bound the wait because a descendant may still hold a pipe.
                    if !ready {
                        let drained_by = Instant::now() + Duration::from_millis(250);
                        while Instant::now() < drained_by
                            && process
                                .drains
                                .iter()
                                .any(|done| !done.load(Ordering::Acquire))
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                    let failure = process.failure.lock().unwrap().clone();
                    if !ready && failure.as_deref() == Some("port-conflict") {
                        break;
                    }
                    return RunResult::Failed(failure.unwrap_or_else(|| format!("The backend exited with {exit}. Open logs for the startup summary, then restart the backend.")));
                }
                Err(_) => {
                    return RunResult::Failed("Could not monitor the owned backend process".into());
                }
                Ok(None) => {}
            }
            if !ready {
                if process.ready.load(Ordering::Acquire) && healthy(port, token) {
                    {
                        let mut shared = state.lock().unwrap();
                        remember_origin(&mut shared.owned_origins, &url);
                        let aliases = serde_json::to_vec(&shared.owned_origins).unwrap();
                        if let Err(error) =
                            secure::write(&root.join("owned-origins.protected"), &aliases)
                        {
                            process.stop();
                            return RunResult::Failed(error);
                        }
                    }
                    ready = true;
                    let _ = fs::write(root.join("last-port"), port.to_string());
                    report(
                        state,
                        emit,
                        "starting",
                        "Checking your AIOStreams accounts…",
                        None,
                    );
                    if let Ok(saved) = accounts::load(root) {
                        let checks: Vec<_> = saved
                            .iter()
                            .map(|account| accounts::check(port, token, account))
                            .collect();
                        for (account, check) in saved.iter().zip(&checks) {
                            match check {
                                Ok(()) => log::info!(
                                    "embedded backend: account {} can use built-in Usenet",
                                    account.username
                                ),
                                Err(_) => log::info!(
                                    "embedded backend: account {} cannot use built-in Usenet",
                                    account.username
                                ),
                            }
                        }
                        state.lock().unwrap().accounts =
                            accounts::summary(&saved, Some(checks.as_slice()));
                    }
                    report(
                        state,
                        emit,
                        "ready",
                        "Local server ready",
                        Some(url.clone()),
                    );
                } else if Instant::now() >= deadline {
                    process.stop();
                    return RunResult::Failed("The backend did not become healthy within four minutes. Open logs, check free disk space, and restart the backend.".into());
                }
            }
        }
        process.stop();
    }
    RunResult::Failed(
        "Could not reserve a local port after three attempts; restart the backend".into(),
    )
}

fn available_port(root: &Path, preferred: bool) -> Result<u16, String> {
    let saved = fs::read_to_string(root.join("last-port"))
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(3000);
    let listener = if preferred {
        TcpListener::bind(("127.0.0.1", saved)).or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
    } else {
        TcpListener::bind(("127.0.0.1", 0))
    };
    listener
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|_| "Windows could not reserve an available loopback port".into())
}

fn healthy(port: u16, token: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    if write!(stream, "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-AIOStreams-Desktop-Token: {token}\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut buffer = [0; 256];
    let Ok(length) = stream.read(&mut buffer) else {
        return false;
    };
    buffer[..length].starts_with(b"HTTP/1.1 200 ") || buffer[..length].starts_with(b"HTTP/1.0 200 ")
}

struct OwnedChild {
    child: Child,
    failure: Arc<Mutex<Option<String>>>,
    ready: Arc<AtomicBool>,
    drains: Vec<Arc<AtomicBool>>,
    #[cfg(windows)]
    _job: windows_job::Job,
}

impl OwnedChild {
    fn start(root: &Path, port: u16, key: &str, token: &str) -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|_| "Cannot find the app installation folder")?;
        let install = exe
            .parent()
            .ok_or("Cannot find the app installation folder")?;
        let node = std::env::var_os("AIOSTREAMS_DESKTOP_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                install.join(if cfg!(windows) {
                    "backend/node.exe"
                } else {
                    "backend/node"
                })
            });
        let server = std::env::var_os("AIOSTREAMS_DESKTOP_SERVER")
            .map(PathBuf::from)
            .unwrap_or_else(|| install.join("backend/app/packages/server/dist/server.js"));
        if !node.is_file() {
            return Err(
                "The bundled Node runtime is missing. Reinstall the complete integrated app."
                    .into(),
            );
        }
        if !server.is_file() {
            return Err(
                "The bundled AIOStreams server is missing. Reinstall the complete integrated app."
                    .into(),
            );
        }
        let base = format!("http://127.0.0.1:{port}");
        // The user's accounts, exactly as a Docker install would set them.
        // Inherited values are dropped so the app's own setting is authoritative.
        let user_accounts = accounts::load(root).unwrap_or_else(|error| {
            log::warn!("embedded backend: starting without user accounts: {error}");
            Vec::new()
        });
        let mut cmd = Command::new(node);
        for name in [
            "AIOSTREAMS_AUTH",
            "AIOSTREAMS_AUTH_PERMISSIONS",
            "AIOSTREAMS_AUTH_ADMINS",
            "AIOSTREAMS_AUTH_PROXY",
        ] {
            cmd.env_remove(name);
        }
        if let Some((auth, permissions)) = accounts::environment(&user_accounts) {
            cmd.env("AIOSTREAMS_AUTH", auth)
                .env("AIOSTREAMS_AUTH_PERMISSIONS", permissions);
        }
        cmd.arg(server)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("NODE_ENV", "production")
            .env("PORT", port.to_string())
            .env("BASE_URL", &base)
            .env("INTERNAL_URL", &base)
            .env("DATABASE_URI", "sqlite://./data/db.sqlite")
            .env("SECRET_KEY", key)
            .env("AIOSTREAMS_DESKTOP_TOKEN", token)
            .env("AIOSTREAMS_DESKTOP_STDIN_CONTROL", "1")
            .env(
                "AIOSTREAMS_DESKTOP_WEB_DIR",
                std::env::var_os("AIOSTREAMS_DESKTOP_WEB_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| install.join("web")),
            )
            .env(
                "AIOSTREAMS_DESKTOP_SOURCE_ARCHIVE",
                std::env::var_os("AIOSTREAMS_DESKTOP_SOURCE_ARCHIVE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| install.join("source/aiostreams-integrated-source.tar.gz")),
            )
            .env(
                "FFPROBE_PATH",
                install.join(if cfg!(windows) {
                    "backend/bin/ffprobe.exe"
                } else {
                    "backend/bin/ffprobe"
                }),
            )
            .env_remove("NODE_OPTIONS");
        #[cfg(windows)]
        let job = windows_job::Job::create()?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000 | 0x00000004);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not launch the bundled backend: {e}"))?;
        #[cfg(windows)]
        if let Err(error) = job.assign_and_resume(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let failure = Arc::new(Mutex::new(None));
        let ready = Arc::new(AtomicBool::new(false));
        let mut drains = Vec::new();
        if let Some(pipe) = child.stdout.take() {
            drains.push(drain(pipe, failure.clone(), Some((port, ready.clone()))));
        }
        if let Some(pipe) = child.stderr.take() {
            drains.push(drain(pipe, failure.clone(), None));
        }
        Ok(Self {
            child,
            failure,
            ready,
            drains,
            #[cfg(windows)]
            _job: job,
        })
    }

    fn stop(&mut self) {
        if let Some(mut input) = self.child.stdin.take() {
            let _ = input.write_all(b"{\"command\":\"shutdown\"}\n");
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                _ => thread::sleep(Duration::from_millis(50)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Arbitrary upstream log text can contain credentials. Keep only classified,
/// fixed diagnostic messages in the native log; never copy raw stdout/stderr.
fn drain(
    mut pipe: impl Read + Send + 'static,
    failure: Arc<Mutex<Option<String>>>,
    ready: Option<(u16, Arc<AtomicBool>)>,
) -> Arc<AtomicBool> {
    let finished = Arc::new(AtomicBool::new(false));
    let done = finished.clone();
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        let mut tail = String::new();
        let mut pending = String::new();
        while let Ok(n) = pipe.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buffer[..n]);
            tail.push_str(&chunk);
            if let Some((port, flag)) = &ready {
                pending.push_str(&chunk);
                while let Some(end) = pending.find('\n') {
                    if let Ok(value) = serde_json::from_str::<Value>(pending[..end].trim()) {
                        if value["event"] == "aiostreams-desktop-ready"
                            && value["port"] == *port
                            && value["url"] == format!("http://127.0.0.1:{port}")
                        {
                            flag.store(true, Ordering::Release);
                        }
                    }
                    pending.drain(..=end);
                }
                if pending.len() > 8192 {
                    pending.clear();
                }
            }
            if let Some(summary) = classify(&tail) {
                let mut old = failure.lock().unwrap();
                if old.as_deref() != Some(summary) {
                    log::warn!("embedded backend diagnostic: {summary}");
                    *old = Some(summary.into());
                }
            }
            if tail.len() > 8192 {
                tail = tail
                    .chars()
                    .rev()
                    .take(1024)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
        done.store(true, Ordering::Release);
    });
    finished
}

fn classify(text: &str) -> Option<&'static str> {
    if text.contains("EADDRINUSE") {
        Some("port-conflict")
    } else if text.contains("ERR_MODULE_NOT_FOUND") || text.contains("Cannot find module") {
        Some("A bundled server module is missing. Reinstall the integrated app.")
    } else if text.contains("NODE_MODULE_VERSION") || text.contains("not a valid Win32") {
        Some("A native module does not match the bundled Node runtime or Windows architecture.")
    } else if text.contains("SQLITE_CANTOPEN") || text.contains("EACCES") {
        Some(
            "The backend cannot access its per-user data folder. Check folder permissions and free disk space.",
        )
    } else if text.contains("ENOSPC") {
        Some("The disk containing the backend data folder is full.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_gate_rejects_lookalikes() {
        let base = "http://127.0.0.1:1234";
        assert!(local_url("http://127.0.0.1:1234/foo", base));
        assert!(!local_url("http://127.0.0.1:12345/foo", base));
        assert!(!local_url("http://127.0.0.1:1234@evil.example/foo", base));
        assert!(!local_url("http://127.0.0.1:1234.evil.example/foo", base));
        assert!(!local_url("https://127.0.0.1:1234/foo", base));
        assert!(valid_owned_origin(base));
        assert!(!valid_owned_origin("http://127.0.0.1:01234"));
        assert!(!valid_owned_origin("http://localhost:1234"));
        assert!(!valid_owned_origin("http://127.0.0.1:1234/path"));
    }
    #[test]
    fn storage_accepts_only_bounded_string_map() {
        assert!(valid_storage(&json!({"jellyfin_credentials":"private"})));
        assert!(!valid_storage(&json!({"x":{"a":"b"}})));
        assert!(!valid_storage(&json!(["a"])));
    }
    #[test]
    fn classifier_does_not_echo_secrets() {
        assert_eq!(
            classify("ERR_MODULE_NOT_FOUND https://user:password@host/?token=secret"),
            Some("A bundled server module is missing. Reinstall the integrated app.")
        );
        assert_eq!(classify("password=private"), None);
    }

    /// Run with AIOSTREAMS_TEST_NODE set to the bundled node executable and
    /// `cargo test backend::tests::subprocess_lifecycle -- --ignored --test-threads=1`.
    /// The fixture implements only the supervisor's health/shutdown contract.
    #[test]
    #[ignore = "requires AIOSTREAMS_TEST_NODE; run on Windows CI and native dev"]
    fn subprocess_lifecycle() {
        let node = std::env::var_os("AIOSTREAMS_TEST_NODE")
            .expect("set AIOSTREAMS_TEST_NODE to the bundled runtime");
        let root = std::env::temp_dir().join(format!(
            "AIOStreams lifecycle ü 日本 {}",
            secure::random_hex().unwrap()
        ));
        secure::directory(&root).unwrap();
        let runtime = root.join(if cfg!(windows) {
            "node runtime.exe"
        } else {
            "node runtime"
        });
        fs::copy(node, &runtime).unwrap();
        let fixture = root.join("server fixture.cjs");
        fs::write(
            &fixture,
            r#"
const http=require('node:http');
const fs=require('node:fs');
if(!fs.existsSync('collision-tested')) { fs.writeFileSync('collision-tested','yes'); process.stderr.write('EADDRINUSE'); process.exit(1); }
if(process.platform==='win32') {
 fs.rmSync('grandchild-port',{force:true});
 require('node:child_process').spawn(process.execPath,['-e',"const h=require('node:http').createServer((q,r)=>r.end());h.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync('grandchild-port',String(h.address().port)));"],{stdio:'ignore'});
}
const expected=process.env.AIOSTREAMS_DESKTOP_TOKEN;
const server=http.createServer((req,res)=>{
 if(req.headers['x-aiostreams-desktop-token']!==expected){res.writeHead(401).end();return;}
 if(req.url==='/crash'){res.end();setTimeout(()=>process.exit(17),20);return;}
 res.writeHead(200,{'content-type':'application/json'}).end('{"success":true}');
});
server.on('error',e=>{process.stderr.write(e.code);process.exit(1)});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>process.stdout.write(JSON.stringify({event:'aiostreams-desktop-ready',port:Number(process.env.PORT),url:process.env.BASE_URL})+'\n'));
process.stdin.on('data',()=>server.close(()=>process.exit(0)));
process.stdin.on('end',()=>server.close(()=>process.exit(0)));
"#,
        )
        .unwrap();
        let data = root.join("data folder");
        secure::directory(&data.join("backend")).unwrap();
        let conflict = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy_port = conflict.local_addr().unwrap().port();
        fs::write(data.join("backend/last-port"), busy_port.to_string()).unwrap();
        // This ignored test runs alone: modifying the test process environment
        // would not be safe in a concurrently running application.
        unsafe {
            std::env::set_var("AIOSTREAMS_DESKTOP_NODE", &runtime);
            std::env::set_var("AIOSTREAMS_DESKTOP_SERVER", &fixture);
        }
        let wait = |backend: &Backend, wanted: &str| {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let status = backend.status();
                if status["state"] == wanted {
                    return status;
                }
                assert!(
                    Instant::now() < deadline,
                    "waiting for {wanted}, got {status}"
                );
                thread::sleep(Duration::from_millis(20));
            }
        };
        let backend = Backend::start(data.clone(), |_| {});
        let ready = wait(&backend, "ready");
        let url = ready["url"].as_str().unwrap();
        assert_ne!(url, format!("http://127.0.0.1:{busy_port}"));
        let old_origin = format!("http://127.0.0.1:{busy_port}");
        assert!(
            !backend.is_origin(&old_origin),
            "historical port must never get the native bridge"
        );
        assert!(
            backend
                .media_url(&format!("{old_origin}/saved?signature=a&&b="))
                .starts_with(&format!("{url}/saved?signature=a&&b=&__desktop_token="))
        );
        let unrelated = "http://127.0.0.1:1/video";
        assert_eq!(backend.media_url(unrelated), unrelated);

        assert!(
            backend
                .bootstrap_url()
                .unwrap()
                .contains("/__desktop/session?__desktop_token=")
        );
        assert!(
            !backend
                .status()
                .to_string()
                .contains(&backend.state.lock().unwrap().token)
        );
        assert_eq!(
            backend.media_url("https://example.test/video?signature=a&&b="),
            "https://example.test/video?signature=a&&b="
        );
        let local = format!("{url}/video?signature=a&&b=");
        assert!(
            backend
                .media_url(&local)
                .starts_with(&format!("{local}&__desktop_token="))
        );
        backend
            .save_storage(json!({"jellyfin_credentials":"private fixture token"}))
            .unwrap();
        backend.restart();
        // Wait for the restart transition before accepting a ready state again.
        wait(&backend, "starting");
        let ready = wait(&backend, "ready");
        let port: u16 = ready["url"]
            .as_str()
            .unwrap()
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let token = backend.state.lock().unwrap().token.clone();
        let mut request = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(request,"GET /crash HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-AIOStreams-Desktop-Token: {token}\r\nConnection: close\r\n\r\n").unwrap();
        drop(request);
        wait(&backend, "failed");
        backend.restart();
        wait(&backend, "ready");
        #[cfg(windows)]
        let grandchild_port: u16 = {
            let file = data.join("backend/grandchild-port");
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(value) = fs::read_to_string(&file) {
                    if let Ok(port) = value.parse() {
                        break port;
                    }
                }
                assert!(Instant::now() < deadline, "owned grandchild did not start");
                thread::sleep(Duration::from_millis(20));
            }
        };
        backend.stop();
        #[cfg(windows)]
        assert!(
            TcpStream::connect(("127.0.0.1", grandchild_port)).is_err(),
            "job left an owned descendant listening"
        );
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "backend listener remained after stop"
        );
        let restarted = Backend::start(data.clone(), |_| {});
        wait(&restarted, "ready");
        assert_eq!(
            restarted.status()["storage"]["jellyfin_credentials"],
            "private fixture token"
        );
        restarted.stop();
        let storage_file = data.join("backend/client-storage.protected");
        fs::write(&storage_file, b"intentionally damaged protected settings").unwrap();
        let damaged = Backend::start(data.clone(), |_| {});
        wait(&damaged, "failed");
        assert!(damaged.save_storage(json!({})).is_err());
        assert_eq!(
            fs::read(&storage_file).unwrap(),
            b"intentionally damaged protected settings"
        );
        damaged.stop();
        fs::remove_file(&storage_file).unwrap();
        fs::remove_file(data.join("backend/server-key.protected")).unwrap();
        fs::write(data.join("backend/data/db.sqlite"), b"existing database").unwrap();
        let missing_key = Backend::start(data.clone(), |_| {});
        wait(&missing_key, "failed");
        assert!(!data.join("backend/server-key.protected").exists());
        missing_key.stop();
        drop(conflict);
        unsafe {
            std::env::remove_var("AIOSTREAMS_DESKTOP_NODE");
            std::env::remove_var("AIOSTREAMS_DESKTOP_SERVER");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
