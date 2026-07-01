use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::metadata_preset::{MetadataField, MetadataPreset};
use crate::ingest::copier::{camera_label_for_path, CopiedFile};
use crate::ingest::scanner::ScanFileKind;

/// Writes a metadata manifest CSV to the project root: one row per copied clip, with
/// the fixed clip columns (filename, camera, source/destination path) followed by one
/// column per metadata field. Every clip row carries the same shoot-wide values, so a
/// single import in iconik tags the whole ingest. Column headers are the field ids so
/// they can be mapped to the iconik metadata view.
pub fn write_metadata_manifest(
    root_path: &str,
    copied_files: &[CopiedFile],
    preset: &MetadataPreset,
    values: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let fields: Vec<&MetadataField> = preset
        .categories
        .iter()
        .flat_map(|category| category.fields.iter())
        .collect();

    let mut text = String::from("filename,camera,source_path,destination_path");
    for field in &fields {
        text.push(',');
        text.push_str(&csv_field(&field.id));
    }
    text.push('\n');

    for file in copied_files
        .iter()
        .filter(|file| !matches!(file.kind, ScanFileKind::Sidecar))
    {
        let filename = Path::new(&file.destination_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        text.push_str(&csv_field(filename));
        text.push(',');
        text.push_str(&csv_field(&camera_label_for_path(&file.source_path)));
        text.push(',');
        text.push_str(&csv_field(&file.source_path));
        text.push(',');
        text.push_str(&csv_field(&file.destination_path));
        for field in &fields {
            text.push(',');
            text.push_str(&csv_field(values.get(&field.id).map(String::as_str).unwrap_or("")));
        }
        text.push('\n');
    }

    let project = Path::new(root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("IngestPilot");
    let out_path = Path::new(root_path).join(format!("{project}_Metadata.csv"));
    fs::write(&out_path, text).map_err(|error| format!("{}: {error}", out_path.display()))?;
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
    use crate::core::metadata_preset::{MetadataCategory, MetadataFieldType};

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

    fn preset() -> MetadataPreset {
        MetadataPreset {
            schema_version: 1,
            id: "iconik".to_string(),
            name: "iconik".to_string(),
            description: None,
            categories: vec![MetadataCategory {
                id: "general".to_string(),
                name: "General".to_string(),
                fields: vec![
                    MetadataField {
                        id: "Campus".to_string(),
                        label: "Campus".to_string(),
                        field_type: MetadataFieldType::Dropdown,
                        options: vec![],
                        default: None,
                    },
                    MetadataField {
                        id: "Keywords".to_string(),
                        label: "Keywords".to_string(),
                        field_type: MetadataFieldType::MultiSelect,
                        options: vec![],
                        default: None,
                    },
                ],
            }],
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn writes_manifest_with_shootwide_values_per_clip() {
        let dir = std::env::temp_dir().join(format!(
            "ingest_pilot_meta_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("dir");
        let files = vec![
            copied("D:/A/FX3_1.MP4", &dir.join("Footage/FX3_1.MP4").to_string_lossy()),
            copied("D:/A/FX3_2.MP4", &dir.join("Footage/FX3_2.MP4").to_string_lossy()),
        ];
        let values = BTreeMap::from([
            ("Campus".to_string(), "Keller".to_string()),
            ("Keywords".to_string(), "baptism, worship".to_string()),
        ]);

        let path =
            write_metadata_manifest(&dir.to_string_lossy(), &files, &preset(), &values).expect("write");
        let body = fs::read_to_string(&path).expect("read");
        let lines: Vec<&str> = body.lines().collect();

        assert_eq!(lines[0], "filename,camera,source_path,destination_path,Campus,Keywords");
        // Both clips carry the same shoot-wide values; commas in Keywords are quoted.
        assert!(lines[1].starts_with("FX3_1.MP4,"));
        assert!(lines[1].contains(",Keller,\"baptism, worship\""));
        assert!(lines[2].contains(",Keller,\"baptism, worship\""));
        assert_eq!(lines.len(), 3);

        let _ = fs::remove_dir_all(dir);
    }
}
