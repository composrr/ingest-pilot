use chrono::Local;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MhlEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub hash: String,
    pub verified: bool,
}

pub fn write_mhl_file(root_path: &Path, entries: &[MhlEntry]) -> Result<PathBuf, String> {
    let path = root_path.join("IngestPilot.mhl");
    let created_at = Local::now().to_rfc3339();
    let mut xml = String::new();

    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<media_hash_list version=\"1.0\" generator=\"Ingest Pilot\">\n");
    xml.push_str(&format!(
        "  <created_at>{}</created_at>\n",
        escape_xml(&created_at)
    ));
    xml.push_str("  <hash_algorithm>xxh3-128</hash_algorithm>\n");
    xml.push_str("  <files>\n");

    for entry in entries {
        xml.push_str("    <file>\n");
        xml.push_str(&format!(
            "      <path>{}</path>\n",
            escape_xml(&entry.relative_path)
        ));
        xml.push_str(&format!("      <size>{}</size>\n", entry.size_bytes));
        xml.push_str(&format!("      <hash>{}</hash>\n", escape_xml(&entry.hash)));
        xml.push_str(&format!("      <verified>{}</verified>\n", entry.verified));
        xml.push_str("    </file>\n");
    }

    xml.push_str("  </files>\n");
    xml.push_str("</media_hash_list>\n");

    fs::write(&path, xml).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_mhl_file_with_hash_entries() {
        let workspace = unique_temp_dir("ingest_pilot_mhl_test");
        fs::create_dir_all(&workspace).expect("workspace");

        let path = write_mhl_file(
            &workspace,
            &[MhlEntry {
                relative_path: "Footage/A001.mp4".to_string(),
                size_bytes: 12,
                hash: "abc123".to_string(),
                verified: true,
            }],
        )
        .expect("mhl writes");

        let xml = fs::read_to_string(path).expect("mhl readable");
        assert!(xml.contains("<media_hash_list"));
        assert!(xml.contains("<path>Footage/A001.mp4</path>"));
        assert!(xml.contains("<hash>abc123</hash>"));

        let _ = fs::remove_dir_all(workspace);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("{prefix}_{suffix}"))
    }
}
