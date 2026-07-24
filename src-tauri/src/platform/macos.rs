// macOS volume enumeration.
//
// Windows-first for DIT mode: this is a best-effort stub that enumerates the mounted
// volumes under `/Volumes` so the app still compiles and behaves sanely on macOS. A
// richer implementation (removable/ejectable flags via DiskArbitration, real volume
// labels) can replace this later; for now it lists each `/Volumes/*` entry as a
// non-removable "unknown" volume with camera detection reused from the scanner.
use crate::platform::Volume;
use std::path::Path;

pub fn list_volumes() -> Vec<Volume> {
    let volumes_dir = Path::new("/Volumes");
    let Ok(entries) = std::fs::read_dir(volumes_dir) else {
        return Vec::new();
    };

    let mut volumes = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let path_string = path.to_string_lossy().to_string();
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let camera_reason =
            crate::ingest::scanner::detect_camera_source_at(&path).map(|source| source.reason);
        volumes.push(Volume {
            path: path_string,
            label,
            nickname: None,
            // Without DiskArbitration we can't reliably tell removable from fixed here;
            // default to non-removable and let a later impl refine it.
            is_removable: false,
            drive_type: "unknown".to_string(),
            total_bytes: 0,
            available_bytes: 0,
            camera_reason,
        });
    }
    volumes
}
