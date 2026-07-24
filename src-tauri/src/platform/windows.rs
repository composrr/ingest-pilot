// Windows volume enumeration (the M12 work).
//
// Enumerates every mounted logical drive with its label, drive type, and free/total
// bytes via the Win32 storage APIs already available through `windows-sys` (the
// `Win32_Storage_FileSystem` feature is enabled in Cargo.toml). Camera detection is
// reused from the scanner so the UI can badge camera cards, and empty/unready removable
// slots (a card reader with no card) are skipped gracefully rather than erroring.
//
// Win32 calls used:
//   * GetLogicalDrives           — bitmask of mounted drive letters (A..Z)
//   * GetDriveTypeW              — removable / fixed / remote / cdrom / ramdisk
//   * GetVolumeInformationW      — volume label
//   * GetDiskFreeSpaceExW        — free + total bytes (and readiness probe)
use crate::platform::Volume;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};

// GetDriveTypeW return codes (avoids depending on the exact const paths across
// windows-sys versions; these values are ABI-stable Win32 constants).
const DRIVE_UNKNOWN: u32 = 0;
const DRIVE_NO_ROOT_DIR: u32 = 1;
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_REMOTE: u32 = 4;
const DRIVE_CDROM: u32 = 5;
const DRIVE_RAMDISK: u32 = 6;

pub fn list_volumes() -> Vec<Volume> {
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Vec::new();
    }

    let mut volumes = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        if let Some(volume) = describe_volume(&root) {
            volumes.push(volume);
        }
    }
    volumes
}

/// Wide (UTF-16, NUL-terminated) encoding of a path for the Win32 W APIs.
fn wide(value: &str) -> Vec<u16> {
    Path::new(value)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Drive classes DIT will enumerate. Network shares (`DRIVE_REMOTE`) are deliberately
/// EXCLUDED: a mapped-but-disconnected SMB mount makes every subsequent blocking call
/// (`GetDiskFreeSpaceExW`, `GetVolumeInformationW`, and `detect_camera_source_at`'s
/// `fs::read_dir`) stall for the full SMB timeout, and because `list_volumes` walks drive
/// letters serially, one dead mapping would hang the entire "Copy From" panel. DIT copy
/// sources/destinations are local cards/SSDs, not network shares, so skipping is correct.
/// `DRIVE_UNKNOWN` / `DRIVE_NO_ROOT_DIR` (unmapped/empty letters) are excluded too.
fn is_enumerable_drive_type(kind: u32) -> bool {
    matches!(
        kind,
        DRIVE_REMOVABLE | DRIVE_FIXED | DRIVE_CDROM | DRIVE_RAMDISK
    )
}

fn drive_type_label(kind: u32) -> &'static str {
    match kind {
        DRIVE_REMOVABLE => "removable",
        DRIVE_FIXED => "fixed",
        DRIVE_REMOTE => "remote",
        DRIVE_CDROM => "cdrom",
        DRIVE_RAMDISK => "ramdisk",
        _ => "unknown",
    }
}

fn describe_volume(root: &str) -> Option<Volume> {
    let root_wide = wide(root);
    let kind = unsafe { GetDriveTypeW(root_wide.as_ptr()) };

    // Skip anything that isn't a local removable/fixed/optical/ramdisk volume. Crucially
    // this excludes DRIVE_REMOTE (network shares): a dead SMB mapping would otherwise
    // block every subsequent call below for the SMB timeout and, since enumeration is
    // serial, hang the whole "Copy From" panel. Unmapped/empty letters are skipped too.
    if !is_enumerable_drive_type(kind) {
        return None;
    }

    // Free/total bytes double as a readiness probe: for a card reader with no card the
    // query fails, and we skip the slot rather than surfacing an unusable card.
    let space = disk_free_space(&root_wide);
    let is_removable_class = matches!(kind, DRIVE_REMOVABLE | DRIVE_CDROM);
    let (total_bytes, available_bytes) = match space {
        Some(values) => values,
        None => {
            // Removable/optical slot with no media inserted — skip gracefully.
            if is_removable_class {
                return None;
            }
            (0, 0)
        }
    };

    let label = volume_label(&root_wide);
    let is_removable = kind == DRIVE_REMOVABLE;

    // Reuse the camera-signature detector so the UI can badge camera cards. Only probe
    // ready volumes (fs::read_dir on an unready drive would fail anyway).
    let camera_reason =
        crate::ingest::scanner::detect_camera_source_at(Path::new(root)).map(|source| source.reason);

    Some(Volume {
        path: root.to_string(),
        label,
        nickname: None,
        is_removable,
        drive_type: drive_type_label(kind).to_string(),
        total_bytes,
        available_bytes,
        camera_reason,
    })
}

/// Volume label via GetVolumeInformationW. Empty string when the volume has no label or
/// the query fails (a not-ready removable), never an error.
fn volume_label(root_wide: &[u16]) -> String {
    let mut name_buffer = [0u16; 261]; // MAX_PATH + 1
    let ok = unsafe {
        GetVolumeInformationW(
            root_wide.as_ptr(),
            name_buffer.as_mut_ptr(),
            name_buffer.len() as u32,
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
    let end = name_buffer
        .iter()
        .position(|&code_unit| code_unit == 0)
        .unwrap_or(name_buffer.len());
    String::from_utf16_lossy(&name_buffer[..end])
}

/// (total_bytes, available_bytes) via GetDiskFreeSpaceExW, or None when the drive is not
/// ready (the caller uses None to skip empty removable slots).
fn disk_free_space(root_wide: &[u16]) -> Option<(u64, u64)> {
    let mut available_bytes = 0u64;
    let mut total_bytes = 0u64;
    let mut total_free_bytes = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            root_wide.as_ptr(),
            &mut available_bytes,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };
    if ok == 0 {
        None
    } else {
        Some((total_bytes, available_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Non-GUI smoke: prints what `list_volumes` enumerates on this machine so the real
    /// drive set can be eyeballed. `#[ignore]` so it never runs in the default suite (it
    /// depends on the machine's mounted drives). Run with:
    ///   cargo test --lib platform::windows::tests::smoke_list_volumes -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_list_volumes() {
        let volumes = list_volumes();
        for volume in &volumes {
            eprintln!(
                "{} label={:?} type={} removable={} total={} free={} camera={:?}",
                volume.path,
                volume.label,
                volume.drive_type,
                volume.is_removable,
                volume.total_bytes,
                volume.available_bytes,
                volume.camera_reason,
            );
        }
        assert!(
            !volumes.is_empty(),
            "at least the system drive should enumerate"
        );
    }

    #[test]
    fn drive_type_labels_are_stable() {
        assert_eq!(drive_type_label(DRIVE_REMOVABLE), "removable");
        assert_eq!(drive_type_label(DRIVE_FIXED), "fixed");
        assert_eq!(drive_type_label(DRIVE_REMOTE), "remote");
        assert_eq!(drive_type_label(DRIVE_CDROM), "cdrom");
        assert_eq!(drive_type_label(DRIVE_RAMDISK), "ramdisk");
        assert_eq!(drive_type_label(999), "unknown");
    }

    #[test]
    fn network_and_unmounted_drives_are_excluded() {
        // The stall fix: mapped network drives (and unmapped/empty letters) must never be
        // probed, so one dead SMB mount can't hang the serial enumeration.
        assert!(!is_enumerable_drive_type(DRIVE_REMOTE));
        assert!(!is_enumerable_drive_type(DRIVE_NO_ROOT_DIR));
        assert!(!is_enumerable_drive_type(DRIVE_UNKNOWN));
        // Local media stays enumerable.
        assert!(is_enumerable_drive_type(DRIVE_REMOVABLE));
        assert!(is_enumerable_drive_type(DRIVE_FIXED));
        assert!(is_enumerable_drive_type(DRIVE_CDROM));
        assert!(is_enumerable_drive_type(DRIVE_RAMDISK));
    }

    #[test]
    fn wide_is_nul_terminated() {
        let encoded = wide("E:\\");
        assert_eq!(encoded.last(), Some(&0));
    }
}
