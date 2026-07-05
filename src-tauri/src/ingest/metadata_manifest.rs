use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::core::metadata_preset::{MetadataField, MetadataPreset};
use crate::ingest::copier::{camera_label_for_path, CopiedFile};
use crate::ingest::scanner::ScanFileKind;

/// A metadata preset attached to a specific destination folder. Clips whose
/// destination path is inside `path_prefix` are tagged with this preset's field
/// defaults instead of (or in addition to) the shoot-wide values — this is what
/// lets different campus folders under one root carry their own metadata.
#[derive(Debug, Clone, Deserialize)]
pub struct FolderMetadataOverride {
    pub path_prefix: String,
    pub preset: MetadataPreset,
}

/// Writes a metadata manifest CSV to the project root: one row per copied clip, with
/// the fixed clip columns (filename, camera, source/destination path) followed by one
/// column per metadata field. Every clip row carries the same shoot-wide values, so a
/// single import in iconik tags the whole ingest. Column headers are the field ids so
/// they can be mapped to the iconik metadata view.
pub fn write_metadata_manifest(
    root_path: &str,
    output_dir: Option<&str>,
    copied_files: &[CopiedFile],
    preset: &MetadataPreset,
    values: &BTreeMap<String, String>,
    folder_overrides: &[FolderMetadataOverride],
) -> Result<PathBuf, String> {
    let base_fields: Vec<&MetadataField> = preset
        .categories
        .iter()
        .flat_map(|category| category.fields.iter())
        .collect();

    // Columns are the base fields followed by any field ids introduced only by
    // folder overrides, so every campus's metadata has a home in one manifest.
    let mut column_ids: Vec<String> = base_fields.iter().map(|field| field.id.clone()).collect();
    for override_entry in folder_overrides {
        for field in override_entry
            .preset
            .categories
            .iter()
            .flat_map(|category| category.fields.iter())
        {
            if !column_ids.iter().any(|id| id == &field.id) {
                column_ids.push(field.id.clone());
            }
        }
    }

    let mut text = String::from("filename,camera,source_path,destination_path");
    for id in &column_ids {
        text.push(',');
        text.push_str(&csv_field(id));
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

        // Start from the shoot-wide values, then overlay the deepest (longest
        // path prefix) folder override this clip landed inside.
        let mut row: BTreeMap<String, String> = values.clone();
        if let Some(override_entry) = deepest_override(folder_overrides, &file.destination_path) {
            for field in override_entry
                .preset
                .categories
                .iter()
                .flat_map(|category| category.fields.iter())
            {
                if let Some(default) = field.default.as_ref().filter(|value| !value.is_empty()) {
                    row.insert(field.id.clone(), default.clone());
                }
            }
        }

        for id in &column_ids {
            text.push(',');
            text.push_str(&csv_field(row.get(id).map(String::as_str).unwrap_or("")));
        }
        text.push('\n');
    }

    let project = Path::new(root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("IngestPilot");
    let dir = output_dir.unwrap_or(root_path);
    let _ = fs::create_dir_all(dir);
    let out_path = Path::new(dir).join(format!("{project}_Metadata.csv"));
    fs::write(&out_path, text).map_err(|error| format!("{}: {error}", out_path.display()))?;
    Ok(out_path)
}

/// Picks the folder override whose path prefix best (most deeply) contains the
/// clip's destination path, so a campus folder wins over its parent Footage folder.
fn deepest_override<'a>(
    overrides: &'a [FolderMetadataOverride],
    destination_path: &str,
) -> Option<&'a FolderMetadataOverride> {
    let normalized = destination_path.replace('\\', "/");
    overrides
        .iter()
        .filter(|entry| {
            let prefix = entry.path_prefix.replace('\\', "/");
            !prefix.is_empty() && normalized.starts_with(&prefix)
        })
        .max_by_key(|entry| entry.path_prefix.len())
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
            write_metadata_manifest(&dir.to_string_lossy(), None, &files, &preset(), &values, &[]).expect("write");
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

    #[test]
    fn folder_override_tags_clips_by_campus_in_one_manifest() {
        let dir = std::env::temp_dir().join(format!(
            "ingest_pilot_meta_ovr_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("dir");
        let keller_path = dir.join("Footage/Keller/A.MP4").to_string_lossy().to_string();
        let hlt_path = dir.join("Footage/HLT/B.MP4").to_string_lossy().to_string();
        let files = vec![copied("D:/A/A.MP4", &keller_path), copied("D:/B/B.MP4", &hlt_path)];
        // Shoot-wide values are empty; each campus folder carries its own Campus default.
        let values = BTreeMap::new();

        fn campus_preset(id: &str, campus: &str) -> MetadataPreset {
            MetadataPreset {
                schema_version: 1,
                id: id.to_string(),
                name: id.to_string(),
                description: None,
                categories: vec![MetadataCategory {
                    id: "general".to_string(),
                    name: "General".to_string(),
                    fields: vec![MetadataField {
                        id: "Campus".to_string(),
                        label: "Campus".to_string(),
                        field_type: MetadataFieldType::Dropdown,
                        options: vec![],
                        default: Some(campus.to_string()),
                    }],
                }],
                created_at: String::new(),
                updated_at: String::new(),
            }
        }

        let overrides = vec![
            FolderMetadataOverride {
                path_prefix: dir.join("Footage/Keller").to_string_lossy().to_string(),
                preset: campus_preset("keller", "Keller"),
            },
            FolderMetadataOverride {
                path_prefix: dir.join("Footage/HLT").to_string_lossy().to_string(),
                preset: campus_preset("hlt", "HLT"),
            },
        ];

        let path =
            write_metadata_manifest(&dir.to_string_lossy(), None, &files, &preset(), &values, &overrides)
                .expect("write");
        let body = fs::read_to_string(&path).expect("read");
        let lines: Vec<&str> = body.lines().collect();

        assert_eq!(lines[0], "filename,camera,source_path,destination_path,Campus,Keywords");
        let keller_line = lines.iter().find(|line| line.starts_with("A.MP4,")).expect("keller row");
        let hlt_line = lines.iter().find(|line| line.starts_with("B.MP4,")).expect("hlt row");
        assert!(keller_line.contains(",Keller,"));
        assert!(hlt_line.contains(",HLT,"));

        let _ = fs::remove_dir_all(dir);
    }
}
