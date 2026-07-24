use serde::Serialize;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

/// A connected logical volume (drive) as seen by DIT mode's "Copy From" panel.
///
/// This is the M12 volume-enumeration surface: unlike the camera-signature letter probe
/// (`scanner::detect_camera_sources`), it lists EVERY mounted fixed/removable volume so a
/// plain drive with a `Footage/` folder is still visible. `camera_reason` is populated by
/// reusing the camera detector so the UI can badge camera cards, and `nickname` is filled
/// in by the command layer from the `drive_nicknames` setting (keyed by `path`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Volume {
    /// Volume root path, e.g. `E:\` on Windows or `/Volumes/CFEXPRESS` on macOS.
    pub path: String,
    /// OS volume label (may be empty when the volume has none).
    pub label: String,
    /// Friendly name from `settings.drive_nicknames`, keyed by `path`. Filled by the
    /// command layer, so the pure platform enumerator always returns `None` here.
    pub nickname: Option<String>,
    /// True for removable media (card readers, USB sticks, external SSDs presenting as
    /// removable). Fixed internal disks and network shares are false.
    pub is_removable: bool,
    /// Coarse drive class: "removable" | "fixed" | "remote" | "cdrom" | "ramdisk" | "unknown".
    pub drive_type: String,
    /// Total capacity of the volume in bytes.
    pub total_bytes: u64,
    /// Free space available to the caller in bytes.
    pub available_bytes: u64,
    /// Some(reason) when the camera-signature detector matched at this volume root
    /// (e.g. "DCIM folder", "Sony M4ROOT folder", "RED RDM/RDC folder"); None otherwise.
    pub camera_reason: Option<String>,
}

/// Enumerate all mounted volumes for the current platform. Never panics; returns an empty
/// vec on platforms without an implementation (Linux) or when enumeration fails.
pub fn list_volumes() -> Vec<Volume> {
    #[cfg(target_os = "windows")]
    {
        windows::list_volumes()
    }
    #[cfg(target_os = "macos")]
    {
        macos::list_volumes()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}
