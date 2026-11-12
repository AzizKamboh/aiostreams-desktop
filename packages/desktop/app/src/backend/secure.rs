//! Windows DPAPI uses the current user's credentials. Portable data remains tied
//! to that Windows user; copying its folder is not a plaintext credential export.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "Could not create the per-user backend data folder")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the backend data folder")?;
    }
    Ok(())
}

pub fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    random(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(windows)]
fn random(bytes: &mut [u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    // SAFETY: the writable buffer is valid for its declared length, and the
    // system-preferred flag requires a null algorithm handle.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        Err("Windows could not generate a secure backend key".into())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn random(bytes: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(bytes))
        .map_err(|_| "Could not obtain operating-system randomness".into())
}

pub fn read(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|_| "Could not read protected backend settings")?;
    unprotect(&bytes)
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("The settings path has no parent folder")?;
    directory(parent)?;
    let protected = protect(bytes)?;
    let temporary = parent.join(format!(".settings-{}.tmp", random_hex()?));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not create protected backend settings")?;
        file.write_all(&protected)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save protected backend settings")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "Could not replace protected backend settings")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "Protected data is too large")?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input outlives the synchronous call; output is allocated by DPAPI
    // and released with LocalFree after copying. No UI or machine-wide scope.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(if encrypt { "Windows could not protect backend credentials" } else { "Windows could not unlock backend credentials. Use the original Windows user or restore a supported configuration export." }.into());
    }
    let value = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(value)
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, false)
}

// Non-Windows development tests use a mode-0600 file. The shipping Windows path
// above always uses DPAPI; this is not advertised as encrypted storage elsewhere.
#[cfg(not(windows))]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}
#[cfg(not(windows))]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secure_settings_survive_replacement_and_unicode_paths() {
        let path =
            std::env::temp_dir().join(format!("AIOStreams tests ü 日本 {}", random_hex().unwrap()));
        let file = path.join("server-key.protected");
        write(&file, b"first-secret").unwrap();
        assert_eq!(read(&file).unwrap(), b"first-secret");
        write(&file, b"replacement-secret").unwrap();
        assert_eq!(read(&file).unwrap(), b"replacement-secret");
        #[cfg(windows)]
        assert!(
            !fs::read(&file)
                .unwrap()
                .windows(b"replacement-secret".len())
                .any(|w| w == b"replacement-secret")
        );
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn keys_are_random_256_bit_hex() {
        let a = random_hex().unwrap();
        let b = random_hex().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
