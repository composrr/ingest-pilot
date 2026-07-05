use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ingest::copier::{camera_label_for_path, CopiedFile};
use crate::ingest::scanner::ScanFileKind;

#[derive(Serialize)]
struct ReelRow {
    filename: String,
    camera: String,
    kind: String,
    size_bytes: u64,
    duration_ms: Option<u64>,
    verified: bool,
    hash: String,
    source_path: String,
    destination_path: String,
}

fn rows(copied_files: &[CopiedFile]) -> Vec<ReelRow> {
    copied_files
        .iter()
        .filter(|file| !matches!(file.kind, ScanFileKind::Sidecar))
        .map(|file| ReelRow {
            filename: Path::new(&file.destination_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            camera: camera_label_for_path(&file.source_path),
            kind: format!("{:?}", file.kind),
            size_bytes: file.size_bytes,
            duration_ms: file.duration_ms,
            verified: file.verified,
            hash: file.destination_hash.clone(),
            source_path: file.source_path.clone(),
            destination_path: file.destination_path.clone(),
        })
        .collect()
}

/// Write a per-clip reel index (one row per copied media file, tagged with its
/// derived camera) to the project root as CSV or JSON. Returns the file path.
pub fn write_reel_index(
    root_path: &str,
    output_dir: Option<&str>,
    copied_files: &[CopiedFile],
    as_csv: bool,
) -> Result<PathBuf, String> {
    let rows = rows(copied_files);
    let project = Path::new(root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("IngestPilot");
    let dir = output_dir.unwrap_or(root_path);
    let _ = fs::create_dir_all(dir);

    let (ext, content) = if as_csv {
        let mut text = String::from(
            "filename,camera,kind,size_bytes,duration_ms,verified,hash,source_path,destination_path\n",
        );
        for row in &rows {
            text.push_str(&format!(
                "{},{},{},{},{},{},{},{},{}\n",
                csv_field(&row.filename),
                csv_field(&row.camera),
                row.kind,
                row.size_bytes,
                row.duration_ms.map(|ms| ms.to_string()).unwrap_or_default(),
                row.verified,
                row.hash,
                csv_field(&row.source_path),
                csv_field(&row.destination_path),
            ));
        }
        ("csv", text)
    } else {
        (
            "json",
            serde_json::to_string_pretty(&rows).map_err(|error| error.to_string())?,
        )
    };

    let out_path = Path::new(dir).join(format!("{project}_ReelIndex.{ext}"));
    fs::write(&out_path, content).map_err(|error| format!("{}: {error}", out_path.display()))?;
    Ok(out_path)
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copied(source: &str, dest: &str) -> CopiedFile {
        CopiedFile {
            source_path: source.to_string(),
            destination_path: dest.to_string(),
            kind: ScanFileKind::Footage,
            size_bytes: 10,
            thumbnail_path: None,
            source_hash: "h".to_string(),
            destination_hash: "h".to_string(),
            verified: true,
            duration_ms: Some(1000),
        }
    }

    #[test]
    fn writes_reel_index_csv_with_derived_camera() {
        let dir = std::env::temp_dir().join(format!(
            "ingest_pilot_reel_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("dir");
        let files = vec![copied(
            "D:/A001/PRIVATE/CLIP/FX3_6713.MP4",
            &dir.join("Footage/FX3_6713.MP4").to_string_lossy(),
        )];
        let path = write_reel_index(&dir.to_string_lossy(), &files, true).expect("write");
        let body = fs::read_to_string(&path).expect("read");
        assert!(body.starts_with("filename,camera,kind"));
        assert!(body.contains("FX3_6713.MP4,FX3,Footage,10,1000,true"));
        let _ = fs::remove_dir_all(dir);
    }
}
