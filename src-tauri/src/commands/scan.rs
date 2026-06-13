use crate::ingest::scanner::{
    detect_camera_sources as detect_sources, scan_source as scan, CameraSource, SourceScan,
};

#[tauri::command]
pub async fn scan_source(source_path: String) -> Result<SourceScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan(&source_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn detect_camera_sources() -> Vec<CameraSource> {
    detect_sources()
}
