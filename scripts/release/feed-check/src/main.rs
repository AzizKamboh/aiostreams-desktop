//! feed-check --feed <url> --channel stable|preview --installed <version>
//!            (--expect <version> | --expect-none) [--download]
//!
//! Pretends to be an installed AIOStreams Integrated <installed> and asks the
//! feed for an update exactly as the app does: Velopack's own client code
//! (same version as the app) plus the app's update_policy.rs checks. With
//! --download it also downloads the package, which Velopack checksums.

#[path = "../../../../packages/desktop/app/src/update_policy.rs"]
#[allow(dead_code)]
mod update_policy;

use std::process::ExitCode;

use update_policy::{Channel, PACKAGE_ID, check_offer};
use velopack::locator::VelopackLocatorConfig;
use velopack::sources::HttpSource;
use velopack::{UpdateCheck, UpdateManager, UpdateOptions};

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().collect();
    let feed = option(&args, "--feed").ok_or("--feed is required")?;
    let channel = match option(&args, "--channel").as_deref() {
        Some("stable") => Channel::Stable,
        Some("preview") => Channel::Preview,
        _ => return Err("--channel stable|preview is required".into()),
    };
    let installed = option(&args, "--installed").ok_or("--installed is required")?;
    let expect = option(&args, "--expect");
    let expect_none = args.iter().any(|a| a == "--expect-none");
    if expect.is_none() == !expect_none {
        return Err("give exactly one of --expect <version> or --expect-none".into());
    }
    let root = std::env::temp_dir().join(format!("aiostreams-feed-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("current")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("packages")).map_err(|e| e.to_string())?;
    // Velopack's locator requires an updater beside the app; it is never run here.
    std::fs::write(root.join("Update.exe"), b"").map_err(|e| e.to_string())?;
    let manifest = root.join("current").join("sq.version");
    std::fs::write(
        &manifest,
        format!(
            "<?xml version=\"1.0\"?><package><metadata><id>{PACKAGE_ID}</id><version>{installed}</version><title>AIOStreams</title><mainExe>aiostreams-desktop.exe</mainExe><channel>{}</channel></metadata></package>",
            channel.velopack()
        ),
    )
    .map_err(|e| e.to_string())?;
    let config = VelopackLocatorConfig {
        RootAppDir: root.clone(),
        UpdateExePath: root.join("Update.exe"),
        PackagesDir: root.join("packages"),
        ManifestPath: manifest,
        CurrentBinaryDir: root.join("current"),
        IsPortable: false,
    };
    let options = UpdateOptions {
        ExplicitChannel: Some(channel.velopack().into()),
        AllowVersionDowngrade: false,
        ..Default::default()
    };
    let manager = UpdateManager::new(HttpSource::new(&feed), Some(options), Some(config)).map_err(|e| e.to_string())?;
    let result = match manager.check_for_updates().map_err(|e| format!("check failed: {e}"))? {
        UpdateCheck::UpdateAvailable(info) => {
            let target = &info.TargetFullRelease;
            check_offer(&target.PackageId, &target.Version, info.DeltasToTarget.iter().map(|d| d.PackageId.as_str()), &installed)
                .map_err(|e| format!("the app would refuse this update: {e}"))?;
            match (&expect, expect_none) {
                (_, true) => return Err(format!("expected no update, the feed offers {}", target.Version)),
                (Some(v), _) if v != &target.Version => return Err(format!("expected {v}, the feed offers {}", target.Version)),
                _ => {}
            }
            if args.iter().any(|a| a == "--download") {
                manager.download_updates(&info, None).map_err(|e| format!("download failed: {e}"))?;
                if !root.join("packages").join(&target.FileName).is_file() {
                    return Err("Velopack reported success but the package is missing".into());
                }
            }
            format!("{installed} -> {} ({}, {} deltas) from {feed}", target.Version, target.FileName, info.DeltasToTarget.len())
        }
        _ if expect_none => format!("{installed}: no update offered, as expected"),
        _ => return Err(format!("expected {}, the feed offers no update for {installed}", expect.unwrap_or_default())),
    };
    let _ = std::fs::remove_dir_all(&root);
    Ok(result)
}

fn main() -> ExitCode {
    match run() {
        Ok(message) => {
            println!("feed-check: {message}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("feed-check: FAILED: {message}");
            ExitCode::FAILURE
        }
    }
}
