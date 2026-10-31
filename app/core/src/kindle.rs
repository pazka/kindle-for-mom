//! Finding the Kindle without asking Mom anything.
//!
//! A Kindle 4 (D01100) plugged in by USB shows up in Windows as a removable
//! drive labelled "Kindle" with `documents\` and `system\` folders. We scan
//! the drive letters every couple of seconds and pick the first one that
//! looks like that. No drive letter is ever shown to her.
//!
//! For development and tests on any OS, `LISEUSE_FAKE_KINDLE=<folder>`
//! makes that folder behave like a plugged-in Kindle.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Kindle {
    /// Root of the drive, e.g. `E:\`.
    pub root: PathBuf,
    /// Volume label as Windows reports it.
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

impl Kindle {
    pub fn documents(&self) -> PathBuf {
        self.root.join("documents")
    }
}

/// Does this folder look like the inside of a Kindle?
pub fn looks_like_kindle(root: &Path, label: &str) -> bool {
    if !root.join("documents").is_dir() {
        return false;
    }
    label.eq_ignore_ascii_case("kindle") || root.join("system").is_dir()
}

/// The plugged-in Kindle, if any.
pub fn find() -> Option<Kindle> {
    if let Some(fake) = std::env::var_os("LISEUSE_FAKE_KINDLE") {
        return fake_kindle(Path::new(&fake));
    }
    platform::find()
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else {
        return 0;
    };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn fake_kindle(root: &Path) -> Option<Kindle> {
    if !looks_like_kindle(root, "Kindle") {
        return None;
    }
    let total = std::env::var("LISEUSE_FAKE_TOTAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_400_000_000u64);
    let used = dir_size(root);
    Some(Kindle {
        root: root.to_path_buf(),
        label: "Kindle".into(),
        total_bytes: total,
        free_bytes: total.saturating_sub(used),
    })
}

/// Ask Windows to eject the drive, so the Kindle leaves USB mode and shows
/// its home screen. Files are already flushed after every copy, so failing
/// to eject never loses data.
pub fn eject(k: &Kindle) -> Result<(), String> {
    if std::env::var_os("LISEUSE_FAKE_KINDLE").is_some() {
        return Ok(());
    }
    platform::eject(&k.root)
}

#[cfg(windows)]
mod platform {
    use super::{looks_like_kindle, Kindle};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};

    const DRIVE_REMOVABLE: u32 = 2;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub fn space(root: &Path) -> Option<(u64, u64)> {
        let w = wide(root);
        let (mut free, mut total, mut _all_free) = (0u64, 0u64, 0u64);
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut free, &mut total, &mut _all_free) };
        (ok != 0).then_some((total, free))
    }

    fn label(root: &Path) -> String {
        let w = wide(root);
        let mut buf = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 {
            return String::new();
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }

    pub fn find() -> Option<Kindle> {
        // never pop "insert a disk" dialogs for empty card readers
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS) };
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = PathBuf::from(format!("{}:\\", (b'A' + i as u8) as char));
            let w = wide(&root);
            if unsafe { GetDriveTypeW(w.as_ptr()) } != DRIVE_REMOVABLE {
                continue;
            }
            let label = label(&root);
            if !looks_like_kindle(&root, &label) {
                continue;
            }
            let (total, free) = space(&root).unwrap_or((0, 0));
            return Some(Kindle {
                root,
                label,
                total_bytes: total,
                free_bytes: free,
            });
        }
        None
    }

    pub fn eject(root: &Path) -> Result<(), String> {
        let letter: String = root.to_string_lossy().chars().take(2).collect(); // "E:"
        if !(letter.len() == 2
            && letter.ends_with(':')
            && letter.as_bytes()[0].is_ascii_alphabetic())
        {
            return Err("lecteur inconnu".into());
        }
        // Same as right-click → Eject in File Explorer.
        let script = format!(
            "(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{letter}').InvokeVerb('Eject')"
        );
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("eject: {status}"))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Kindle;
    use std::path::Path;

    pub fn find() -> Option<Kindle> {
        None
    }
    pub fn eject(_root: &Path) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_kindle_layout() {
        let d = std::env::temp_dir().join(format!("k-detect-{}", std::process::id()));
        std::fs::create_dir_all(d.join("documents")).unwrap();
        assert!(looks_like_kindle(&d, "KINDLE"));
        assert!(!looks_like_kindle(&d, "USB"));
        std::fs::create_dir_all(d.join("system")).unwrap();
        assert!(looks_like_kindle(&d, "USB"));
        std::fs::remove_dir_all(&d).ok();
        assert!(!looks_like_kindle(&d, "Kindle"));
    }
}
