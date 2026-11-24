//! AIOMetadata, run privately beside the AIOStreams server (integration-owned).
//!
//! The installed app contains `aiometadata/app` (the pinned AIOMetadata release,
//! unmodified), `aiometadata/desktop/preload.cjs` and `aiometadata/redis` (the
//! Redis 8 server AIOMetadata requires). This supervisor starts Redis, then
//! AIOMetadata on the bundled Node runtime, keeps both to 127.0.0.1, and stops
//! both with the app. The user adds `http://127.0.0.1:<port>/stremio/<uuid>/manifest.json`
//! to AIOStreams as a custom addon after configuring AIOMetadata in a browser.
//!
//! Per-user data lives in `<data>/aiometadata`: `state` (AIOMetadata's working
//! folder: its SQLite database and caches in `addon/data`, and an optional
//! `.env` for extra settings), `redis` (append-only file), the port and a
//! DPAPI-protected signing secret. The install folder is never written.
//!
//! Like the AIOStreams server, raw child output is never copied to the native
//! log; only classified, fixed messages are.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::secure;
#[cfg(windows)]
use super::windows_job;

/// AIOMetadata's own default; kept stable so a manifest URL added to
/// AIOStreams keeps working across launches.
const PREFERRED_PORT: u16 = 3232;
const REDIS_START_TIMEOUT: Duration = Duration::from_secs(120);
/// The first start downloads ID-mapping datasets before reporting ready.
const START_TIMEOUT: Duration = Duration::from_secs(600);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const CRASH_RESTART_AFTER: Duration = Duration::from_secs(60);
/// AIOMetadata's ADMIN_KEY (its dashboard login), chosen in the first-run
/// setup like the AIOStreams account, kept with DPAPI.
const ADMIN_KEY_FILE: &str = "admin-key.protected";
/// The user chose to continue without an admin key; do not ask again.
const ADMIN_KEY_SKIPPED: &str = "admin-key-skipped";

type Changed = Arc<dyn Fn(Value) + Send + Sync>;

enum Control {
    Restart,
    Stop,
}

struct Status {
    phase: &'static str,
    message: String,
    url: Option<String>,
    root: PathBuf,
}

pub struct AioMetadata {
    commands: mpsc::Sender<Control>,
    worker: Mutex<Option<JoinHandle<()>>>,
    status: Arc<Mutex<Status>>,
    changed: Changed,
    root: PathBuf,
}

/// Installed files, resolved once per launch.
struct Install {
    node: PathBuf,
    server: PathBuf,
    app: PathBuf,
    preload: PathBuf,
    redis: PathBuf,
}

impl Install {
    fn locate() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|_| "Cannot find the app installation folder")?;
        let install = exe
            .parent()
            .ok_or("Cannot find the app installation folder")?
            .to_path_buf();
        let node = std::env::var_os("AIOSTREAMS_DESKTOP_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                install.join(if cfg!(windows) {
                    "backend/node.exe"
                } else {
                    "backend/node"
                })
            });
        // Development override: a folder laid out like the installed `aiometadata`.
        let root = std::env::var_os("AIOMETADATA_DESKTOP_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| install.join("aiometadata"));
        let app = root.join("app");
        Ok(Self {
            node,
            server: app.join("dist/server/server.js"),
            preload: root.join("desktop/preload.cjs"),
            redis: root.join(if cfg!(windows) {
                "redis/redis-server.exe"
            } else {
                "redis/redis-server"
            }),
            app,
        })
    }

    fn bundled(&self) -> bool {
        self.server.is_file() && self.preload.is_file() && self.redis.is_file()
    }
}

impl AioMetadata {
    pub fn start(data_dir: &Path, changed: impl Fn(Value) + Send + Sync + 'static) -> Self {
        let root = data_dir.join("aiometadata");
        let status = Arc::new(Mutex::new(Status {
            phase: "starting",
            message: "Starting AIOMetadata…".into(),
            url: None,
            root: root.clone(),
        }));
        let (commands, received) = mpsc::channel();
        let changed: Changed = Arc::new(changed);
        let shared = status.clone();
        let (worker_root, worker_changed) = (root.clone(), changed.clone());
        let worker = thread::Builder::new()
            .name("embedded-aiometadata".into())
            .spawn(move || run(worker_root, received, shared, worker_changed))
            .ok();
        if worker.is_none() {
            let mut s = status.lock().unwrap();
            s.phase = "failed";
            s.message = "Windows could not start the AIOMetadata supervisor thread".into();
        }
        Self {
            commands,
            worker: Mutex::new(worker),
            status,
            changed,
            root,
        }
    }

    pub fn status(&self) -> Value {
        snapshot(&self.status)
    }

    /// Save AIOMetadata's admin key and restart it with the key, or (None)
    /// remember that the user continues without one.
    pub fn set_admin_key(&self, key: Option<&str>) -> Result<(), String> {
        secure::directory(&self.root)?;
        match key {
            Some(key) => {
                if let Some(problem) = admin_key_problem(key) {
                    return Err(problem.into());
                }
                secure::write(&self.root.join(ADMIN_KEY_FILE), key.as_bytes())?;
                let _ = fs::remove_file(self.root.join(ADMIN_KEY_SKIPPED));
                log::info!("embedded aiometadata: admin key saved");
                self.restart();
            }
            None => {
                fs::write(self.root.join(ADMIN_KEY_SKIPPED), b"skipped")
                    .map_err(|_| "Could not save the choice")?;
                (self.changed)(snapshot(&self.status));
            }
        }
        Ok(())
    }

    pub fn restart(&self) {
        let _ = self.commands.send(Control::Restart);
    }

    pub fn stop(&self) {
        let _ = self.commands.send(Control::Stop);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for AioMetadata {
    fn drop(&mut self) {
        self.stop();
    }
}

fn snapshot(status: &Mutex<Status>) -> Value {
    let s = status.lock().unwrap();
    json!({
        "state": s.phase,
        "message": s.message,
        "url": s.url,
        "manifestHint": s.url.as_ref().map(|url| format!("{url}/stremio/<your-uuid>/manifest.json")),
        "adminKey": admin_key_state(&s.root),
    })
}

/// "set", "skipped" or "unset" (ask in the first-run setup). Never the key.
fn admin_key_state(root: &Path) -> &'static str {
    if root.join(ADMIN_KEY_FILE).exists() {
        "set"
    } else if root.join(ADMIN_KEY_SKIPPED).exists() {
        "skipped"
    } else {
        "unset"
    }
}

/// AIOMetadata compares the key with an `X-Admin-Key` header, so it must be
/// a header-safe value; long enough to resist guessing by local programs.
fn admin_key_problem(key: &str) -> Option<&'static str> {
    let length = key.chars().count();
    if length < 12 {
        Some("Use at least 12 characters")
    } else if length > 256 {
        Some("Use at most 256 characters")
    } else if !key.chars().all(|c| c.is_ascii_graphic()) {
        Some("Use letters, digits and symbols only, without spaces")
    } else {
        None
    }
}

/// The saved admin key, if any. An unreadable one (another Windows user's
/// data) is reported and skipped rather than stopping AIOMetadata.
fn read_admin_key(root: &Path) -> Option<String> {
    let file = root.join(ADMIN_KEY_FILE);
    if !file.exists() {
        return None;
    }
    match secure::read(&file).map(String::from_utf8) {
        Ok(Ok(key)) if admin_key_problem(&key).is_none() => Some(key),
        _ => {
            log::warn!(
                "embedded aiometadata: the saved admin key cannot be read; starting without it"
            );
            None
        }
    }
}

fn report(
    status: &Mutex<Status>,
    changed: &Changed,
    phase: &'static str,
    message: &str,
    url: Option<String>,
) {
    {
        let mut s = status.lock().unwrap();
        s.phase = phase;
        s.message = message.into();
        s.url = url;
    }
    log::info!("embedded aiometadata: {phase}: {message}");
    changed(snapshot(status));
}

enum RunResult {
    Stop,
    Restart,
    Failed(String),
    Crashed(String, Duration),
}

fn run(
    root: PathBuf,
    received: mpsc::Receiver<Control>,
    status: Arc<Mutex<Status>>,
    changed: Changed,
) {
    let install = match Install::locate() {
        Ok(install) if install.bundled() => install,
        Ok(_) => {
            report(
                &status,
                &changed,
                "unavailable",
                "AIOMetadata is not included in this build",
                None,
            );
            let _ = received.recv();
            return;
        }
        Err(error) => {
            report(&status, &changed, "failed", &error, None);
            let _ = received.recv();
            return;
        }
    };
    loop {
        report(&status, &changed, "starting", "Starting AIOMetadata…", None);
        match launch(&install, &root, &received, &status, &changed) {
            RunResult::Stop => {
                report(
                    &status,
                    &changed,
                    "stopped",
                    "AIOMetadata has stopped",
                    None,
                );
                return;
            }
            RunResult::Restart => continue,
            RunResult::Failed(message) => report(&status, &changed, "failed", &message, None),
            RunResult::Crashed(message, ran) if ran >= CRASH_RESTART_AFTER => {
                log::warn!("embedded aiometadata: stopped unexpectedly, restarting: {message}");
                continue;
            }
            RunResult::Crashed(message, _) => report(&status, &changed, "failed", &message, None),
        }
        match received.recv() {
            Ok(Control::Restart) => continue,
            _ => return,
        }
    }
}

/// Folders and the persistent signing secret for AIOMetadata's image URLs.
fn prepare(root: &Path) -> Result<String, String> {
    secure::directory(root)?;
    secure::directory(&root.join("state"))?;
    secure::directory(&root.join("state/addon/data"))?;
    secure::directory(&root.join("redis"))?;
    let secret_file = root.join("signing-secret.protected");
    if secret_file.exists() {
        let secret = String::from_utf8(secure::read(&secret_file)?)
            .map_err(|_| "The saved AIOMetadata signing secret is damaged")?;
        if secret.len() == 64 && secret.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Ok(secret);
        }
        return Err("The saved AIOMetadata signing secret is invalid".into());
    }
    let secret = secure::random_hex()?;
    secure::write(&secret_file, secret.as_bytes())?;
    Ok(secret)
}

fn launch(
    install: &Install,
    root: &Path,
    received: &mpsc::Receiver<Control>,
    status: &Mutex<Status>,
    changed: &Changed,
) -> RunResult {
    if !install.node.is_file() {
        return RunResult::Failed(
            "The bundled Node runtime is missing. Reinstall the complete integrated app.".into(),
        );
    }
    let secret = match prepare(root) {
        Ok(secret) => secret,
        Err(error) => return RunResult::Failed(error),
    };
    let password = match secure::random_hex() {
        Ok(password) => password,
        Err(error) => return RunResult::Failed(error),
    };
    let mut redis = None;
    for _ in 0..3 {
        match start_redis(install, root, &password) {
            Ok(started) => {
                redis = Some(started);
                break;
            }
            Err(Retry::Again) => continue,
            Err(Retry::Fatal(error)) => return RunResult::Failed(error),
        }
    }
    let Some(mut redis) = redis else {
        return RunResult::Failed(
            "Could not start AIOMetadata's Redis after three attempts".into(),
        );
    };
    let deadline = Instant::now() + REDIS_START_TIMEOUT;
    loop {
        match control(received) {
            Some(Control::Stop) => {
                redis.stop(&password);
                return RunResult::Stop;
            }
            Some(Control::Restart) => {
                redis.stop(&password);
                return RunResult::Restart;
            }
            None => {}
        }
        if let Ok(Some(exit)) = redis.child.child.try_wait() {
            return RunResult::Failed(redis.child.failure().unwrap_or_else(|| {
                format!("AIOMetadata's Redis exited with {exit} while starting")
            }));
        }
        if resp(redis.port, &password, &["PING"]).is_ok_and(|r| r.starts_with("+PONG")) {
            break;
        }
        if Instant::now() >= deadline {
            redis.stop(&password);
            return RunResult::Failed(
                "AIOMetadata's Redis did not start within two minutes".into(),
            );
        }
    }
    // The password was only needed on disk for Redis to read it.
    let _ = fs::remove_file(root.join("redis/redis.conf"));

    for attempt in 0..3 {
        let port = match metadata_port(root, attempt == 0) {
            Ok(port) => port,
            Err(error) => {
                redis.stop(&password);
                return RunResult::Failed(error);
            }
        };
        let url = format!("http://127.0.0.1:{port}");
        let mut server = match start_server(
            install,
            root,
            port,
            &password,
            redis.port,
            &secret,
            read_admin_key(root).as_deref(),
        ) {
            Ok(server) => server,
            Err(error) => {
                redis.stop(&password);
                return RunResult::Failed(error);
            }
        };
        let deadline = Instant::now() + START_TIMEOUT;
        let mut ready_at: Option<Instant> = None;
        loop {
            match control(received) {
                Some(command) => {
                    stop_server(&mut server);
                    redis.stop(&password);
                    return match command {
                        Control::Stop => RunResult::Stop,
                        Control::Restart => RunResult::Restart,
                    };
                }
                None => {}
            }
            if let Ok(Some(exit)) = redis.child.child.try_wait() {
                stop_server(&mut server);
                let message = format!("AIOMetadata's Redis stopped unexpectedly ({exit})");
                return match ready_at {
                    Some(at) => RunResult::Crashed(message, at.elapsed()),
                    None => RunResult::Failed(message),
                };
            }
            match server.child.try_wait() {
                Ok(Some(exit)) => {
                    server.settle();
                    let failure = server.failure();
                    if ready_at.is_none() && failure.as_deref() == Some("port-conflict") {
                        break;
                    }
                    redis.stop(&password);
                    let message = failure.unwrap_or_else(|| {
                        format!("AIOMetadata exited with {exit}. Restart it from Settings → Local server.")
                    });
                    return match ready_at {
                        Some(at) => RunResult::Crashed(message, at.elapsed()),
                        None => RunResult::Failed(message),
                    };
                }
                Err(_) => {
                    redis.stop(&password);
                    return RunResult::Failed("Could not monitor the AIOMetadata process".into());
                }
                Ok(None) => {}
            }
            if ready_at.is_none() {
                if ready(port) {
                    ready_at = Some(Instant::now());
                    *server.failure.lock().unwrap() = None;
                    let _ = fs::write(root.join("port"), port.to_string());
                    let message = if port == PREFERRED_PORT {
                        "AIOMetadata ready".to_string()
                    } else {
                        format!(
                            "AIOMetadata ready on port {port} because {PREFERRED_PORT} is in use; update its manifest URL in AIOStreams if it changed"
                        )
                    };
                    report(status, changed, "ready", &message, Some(url.clone()));
                } else if Instant::now() >= deadline {
                    stop_server(&mut server);
                    redis.stop(&password);
                    return RunResult::Failed("AIOMetadata did not become ready within ten minutes. Check your internet connection and restart it.".into());
                }
            }
        }
        stop_server(&mut server);
    }
    redis.stop(&password);
    RunResult::Failed("Could not reserve a local port for AIOMetadata; restart it".into())
}

fn control(received: &mpsc::Receiver<Control>) -> Option<Control> {
    match received.recv_timeout(Duration::from_millis(200)) {
        Ok(command) => Some(command),
        Err(mpsc::RecvTimeoutError::Disconnected) => Some(Control::Stop),
        Err(mpsc::RecvTimeoutError::Timeout) => None,
    }
}

enum Retry {
    Again,
    Fatal(String),
}

struct Redis {
    child: Owned,
    port: u16,
}

impl Redis {
    /// SHUTDOWN flushes the append-only file; killing is the fallback.
    fn stop(&mut self, password: &str) {
        let _ = resp(self.port, password, &["SHUTDOWN"]);
        self.child.wait_or_kill(STOP_TIMEOUT);
    }
}

/// The Redis configuration. Paths stay relative to the working directory, so
/// no Windows path ever passes through Redis's POSIX runtime.
fn redis_config(port: u16, password: &str) -> String {
    [
        "bind 127.0.0.1".to_string(),
        "protected-mode yes".into(),
        format!("port {port}"),
        format!("requirepass {password}"),
        "dir .".into(),
        // Snapshots need fork(), which is slow and fragile on this runtime;
        // the append-only file keeps sessions and Jellyfin state across restarts.
        "save \"\"".into(),
        "appendonly yes".into(),
        "appendfsync everysec".into(),
        // AIOMetadata sets volatile-lfu: only cache keys (all with a TTL) are evicted.
        "maxmemory 1gb".into(),
        "daemonize no".into(),
        "loglevel warning".into(),
        "logfile \"\"".into(),
        String::new(),
    ]
    .join("\n")
}

fn start_redis(install: &Install, root: &Path, password: &str) -> Result<Redis, Retry> {
    let port = free_port().map_err(Retry::Fatal)?;
    let dir = root.join("redis");
    fs::write(dir.join("redis.conf"), redis_config(port, password))
        .map_err(|_| Retry::Fatal("Could not write AIOMetadata's Redis settings".into()))?;
    let mut cmd = Command::new(&install.redis);
    cmd.arg("redis.conf").current_dir(&dir);
    let child = Owned::spawn(cmd, "AIOMetadata's Redis").map_err(Retry::Fatal)?;
    // A port taken between reservation and bind shows up as an early exit.
    thread::sleep(Duration::from_millis(300));
    let mut redis = Redis { child, port };
    if let Ok(Some(_)) = redis.child.child.try_wait() {
        redis.child.settle();
        return match redis.child.failure().as_deref() {
            Some("port-conflict") => Err(Retry::Again),
            Some(other) => Err(Retry::Fatal(other.to_string())),
            None => Err(Retry::Fatal(
                "AIOMetadata's Redis exited while starting".into(),
            )),
        };
    }
    Ok(redis)
}

fn start_server(
    install: &Install,
    root: &Path,
    port: u16,
    password: &str,
    redis_port: u16,
    secret: &str,
    admin_key: Option<&str>,
) -> Result<Owned, String> {
    let url = format!("http://127.0.0.1:{port}");
    let mut cmd = Command::new(&install.node);
    cmd.arg("-r")
        .arg(&install.preload)
        .arg(&install.server)
        .current_dir(root.join("state"))
        .env_remove("NODE_OPTIONS")
        .env("NODE_ENV", "production")
        .env("NODE_COMPILE_CACHE", root.join("compile-cache"))
        .env("UV_THREADPOOL_SIZE", "16")
        .env("DOTENV_CONFIG_QUIET", "true")
        .env("PORT", port.to_string())
        .env("HOST_NAME", &url)
        .env("DATABASE_URI", "sqlite://./addon/data/db.sqlite")
        .env(
            "REDIS_URL",
            format!("redis://:{password}@127.0.0.1:{redis_port}"),
        )
        .env("IMAGE_PROXY_SIGNING_SECRET", secret)
        .env("AIOMETADATA_DESKTOP_APP_ROOT", &install.app)
        .env("AIOMETADATA_DESKTOP_STDIN_CONTROL", "1");
    // The key from the setup screen; without one, a .env ADMIN_KEY still applies.
    if let Some(key) = admin_key {
        cmd.env("ADMIN_KEY", key);
    }
    // Background warming suits a shared server, not a personal desktop. These
    // are defaults only: a `.env` in the state folder cannot override variables
    // set here, so they are skipped when the user's own environment sets them.
    for (name, value) in [
        ("ENABLE_CACHE_WARMING", "false"),
        ("CACHE_WARMUP_ON_STARTUP", "false"),
        ("MAL_WARMUP_ENABLED", "false"),
        ("TMDB_POPULAR_WARMING_ENABLED", "false"),
    ] {
        if std::env::var_os(name).is_none() && !dotenv_sets(root, name) {
            cmd.env(name, value);
        }
    }
    Owned::spawn(cmd, "AIOMetadata")
}

/// Whether the user's optional `.env` in the state folder sets this name.
fn dotenv_sets(root: &Path, name: &str) -> bool {
    fs::read_to_string(root.join("state/.env")).is_ok_and(|text| {
        text.lines().any(|line| {
            let line = line.trim_start();
            let line = line.strip_prefix("export ").unwrap_or(line);
            line.split_once('=')
                .is_some_and(|(key, _)| key.trim() == name)
        })
    })
}

fn stop_server(server: &mut Owned) {
    if let Some(mut input) = server.child.stdin.take() {
        let _ = input.write_all(b"{\"command\":\"shutdown\"}\n");
    }
    server.wait_or_kill(STOP_TIMEOUT);
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|_| "Windows could not reserve an available loopback port".into())
}

/// The saved port (normally 3232), so the manifest URL stays valid; another
/// free port only when that one is taken.
fn metadata_port(root: &Path, preferred: bool) -> Result<u16, String> {
    let saved = fs::read_to_string(root.join("port"))
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(PREFERRED_PORT);
    if preferred {
        for port in [saved, PREFERRED_PORT] {
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return Ok(port);
            }
        }
    }
    free_port()
}

fn ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(1000));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    if write!(
        stream,
        "GET /health/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut buffer = [0; 64];
    let Ok(length) = stream.read(&mut buffer) else {
        return false;
    };
    buffer[..length].starts_with(b"HTTP/1.1 200 ")
}

fn resp_encode(parts: &[&str]) -> String {
    let mut out = format!("*{}\r\n", parts.len());
    for part in parts {
        out.push_str(&format!("${}\r\n{part}\r\n", part.len()));
    }
    out
}

/// One authenticated command; QUIT makes Redis close after replying, so the
/// whole reply is read. Returns the command's reply after AUTH's `+OK`.
fn resp(port: u16, password: &str, command: &[&str]) -> Result<String, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300))
        .map_err(|_| "Redis is not listening")?;
    let timeout = Some(Duration::from_secs(3));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = format!(
        "{}{}{}",
        resp_encode(&["AUTH", password]),
        resp_encode(command),
        resp_encode(&["QUIT"])
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "Could not send to Redis")?;
    let mut reply = Vec::new();
    let _ = stream.take(64 * 1024).read_to_end(&mut reply);
    let reply = String::from_utf8_lossy(&reply);
    reply
        .strip_prefix("+OK\r\n")
        .map(str::to_owned)
        .ok_or_else(|| "Redis refused the connection".into())
}

/// A child in its own kill-on-close job (Windows), with classified output.
struct Owned {
    child: Child,
    failure: Arc<Mutex<Option<String>>>,
    drains: Vec<Arc<std::sync::atomic::AtomicBool>>,
    #[cfg(windows)]
    _job: windows_job::Job,
}

impl Owned {
    fn spawn(mut cmd: Command, what: &str) -> Result<Self, String> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        let job = windows_job::Job::create()?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window; suspended until it is inside the job.
            cmd.creation_flags(0x08000000 | 0x00000004);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not launch {what}: {e}"))?;
        #[cfg(windows)]
        if let Err(error) = job.assign_and_resume(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let failure = Arc::new(Mutex::new(None));
        let mut drains = Vec::new();
        if let Some(pipe) = child.stdout.take() {
            drains.push(super::drain(pipe, failure.clone(), None));
        }
        if let Some(pipe) = child.stderr.take() {
            drains.push(super::drain(pipe, failure.clone(), None));
        }
        Ok(Self {
            child,
            failure,
            drains,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Exit can be observed before the pipe readers finish; bound the wait.
    fn settle(&self) {
        let until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < until && self.drains.iter().any(|d| !d.load(Ordering::Acquire)) {
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }

    fn wait_or_kill(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_config_stays_private_and_path_free() {
        let conf = redis_config(4242, "abc");
        assert!(conf.lines().any(|l| l == "bind 127.0.0.1"));
        assert!(conf.lines().any(|l| l == "protected-mode yes"));
        assert!(conf.lines().any(|l| l == "requirepass abc"));
        assert!(conf.lines().any(|l| l == "dir ."));
        assert!(conf.lines().any(|l| l == "appendonly yes"));
        assert!(!conf.contains(':'), "no absolute paths reach Redis");
    }

    #[test]
    fn resp_encoding_is_length_prefixed() {
        assert_eq!(
            resp_encode(&["AUTH", "pässword"]),
            "*2\r\n$4\r\nAUTH\r\n$9\r\npässword\r\n"
        );
    }

    #[test]
    fn admin_key_rules() {
        assert!(admin_key_problem("short").is_some());
        assert!(admin_key_problem("has a space in it").is_some());
        assert!(admin_key_problem("ünicode-letters-x").is_some());
        assert!(admin_key_problem(&"x".repeat(257)).is_some());
        assert!(admin_key_problem("Correct-Horse_Battery#9").is_none());
    }

    #[test]
    fn admin_key_is_saved_skipped_and_reported_never_shown() {
        let data = std::env::temp_dir().join(format!(
            "aiometadata-admin-{}",
            secure::random_hex().unwrap()
        ));
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let service = AioMetadata::start(&data, {
            let seen = seen.clone();
            move |status| seen.lock().unwrap().push(status)
        });
        assert_eq!(service.status()["adminKey"], "unset");
        assert!(service.set_admin_key(Some("short")).is_err());
        service.set_admin_key(None).unwrap();
        assert_eq!(service.status()["adminKey"], "skipped");
        assert_eq!(
            seen.lock().unwrap().last().unwrap()["adminKey"],
            "skipped",
            "skipping is announced"
        );
        service
            .set_admin_key(Some("Correct-Horse_Battery#9"))
            .unwrap();
        assert_eq!(service.status()["adminKey"], "set");
        let root = data.join("aiometadata");
        assert_eq!(
            read_admin_key(&root).as_deref(),
            Some("Correct-Horse_Battery#9")
        );
        assert!(!service.status().to_string().contains("Correct-Horse"));
        service.stop();
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn dotenv_detection() {
        let root = std::env::temp_dir().join(format!(
            "aiometadata-dotenv-{}",
            secure::random_hex().unwrap()
        ));
        fs::create_dir_all(root.join("state")).unwrap();
        assert!(!dotenv_sets(&root, "ENABLE_CACHE_WARMING"));
        fs::write(
            root.join("state/.env"),
            "# comment\nexport ENABLE_CACHE_WARMING=true\nTMDB_API_KEY = x\n",
        )
        .unwrap();
        assert!(dotenv_sets(&root, "ENABLE_CACHE_WARMING"));
        assert!(dotenv_sets(&root, "TMDB_API_KEY"));
        assert!(!dotenv_sets(&root, "MAL_WARMUP_ENABLED"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saved_port_is_preferred_and_a_busy_one_is_replaced() {
        let root = std::env::temp_dir().join(format!(
            "aiometadata-port-{}",
            secure::random_hex().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let busy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy_port = busy.local_addr().unwrap().port();
        fs::write(root.join("port"), busy_port.to_string()).unwrap();
        let chosen = metadata_port(&root, true).unwrap();
        assert_ne!(chosen, busy_port);
        drop(busy);
        assert_eq!(metadata_port(&root, true).unwrap(), busy_port);
        let _ = fs::remove_dir_all(root);
    }

    /// Run with AIOMETADATA_DESKTOP_ROOT set to a staged `aiometadata` folder and
    /// AIOSTREAMS_DESKTOP_NODE to Node 24:
    /// `cargo test -p aiostreams-desktop aiometadata::tests::lifecycle -- --ignored`
    #[test]
    #[ignore = "requires a staged AIOMetadata; run on Windows CI and native dev"]
    fn lifecycle() {
        assert!(std::env::var_os("AIOMETADATA_DESKTOP_ROOT").is_some());
        let data = std::env::temp_dir().join(format!(
            "AIOMetadata lifecycle ü {}",
            secure::random_hex().unwrap()
        ));
        let service = AioMetadata::start(&data, |_| {});
        let deadline = Instant::now() + Duration::from_secs(300);
        let url = loop {
            let status = service.status();
            if status["state"] == "ready" {
                break status["url"].as_str().unwrap().to_string();
            }
            assert_ne!(status["state"], "failed", "{status}");
            assert_ne!(status["state"], "unavailable", "{status}");
            assert!(Instant::now() < deadline, "not ready: {status}");
            thread::sleep(Duration::from_millis(200));
        };
        let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
        assert!(ready(port));
        assert!(
            !data.join("aiometadata/redis/redis.conf").exists(),
            "the Redis password must not stay on disk"
        );
        assert!(data.join("aiometadata/state/addon/data/db.sqlite").exists());
        // Without an admin key, AIOMetadata's admin API is closed.
        let admin = |key: &str| {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                stream,
                "GET /api/config/stats HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Admin-Key: {key}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply);
            reply.split(' ').nth(1).unwrap_or("").to_string()
        };
        assert_eq!(admin("anything-at-all"), "401");
        // The key from the setup screen restarts AIOMetadata with ADMIN_KEY.
        service
            .set_admin_key(Some("Lifecycle-Admin_Key#1"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(300);
        thread::sleep(Duration::from_millis(500));
        while service.status()["state"] != "ready" {
            assert!(Instant::now() < deadline, "not ready after restart");
            thread::sleep(Duration::from_millis(200));
        }
        assert_eq!(admin("Lifecycle-Admin_Key#1"), "200");
        assert_eq!(admin("a-wrong-admin-key"), "401");
        service.stop();
        assert!(!ready(port), "AIOMetadata still answering after stop");
        assert_eq!(service.status()["state"], "stopped");
        let _ = fs::remove_dir_all(data);
    }
}
