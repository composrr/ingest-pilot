use crate::core::hash::xxh3_128_file_hash;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VerificationResult {
    pub source_hash: String,
    pub destination_hash: String,
    pub verified: bool,
}

pub fn verify_copy(
    source_path: &Path,
    destination_path: &Path,
) -> Result<VerificationResult, String> {
    let source_hash = xxh3_128_file_hash(source_path)?;
    let destination_hash = xxh3_128_file_hash(destination_path)?;
    let verified = source_hash == destination_hash;

    Ok(VerificationResult {
        source_hash,
        destination_hash,
        verified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn verifies_matching_copy() {
        let workspace = unique_temp_dir("ingest_pilot_verify_test");
        fs::create_dir_all(&workspace).expect("workspace");
        let source = workspace.join("source.bin");
        let destination = workspace.join("destination.bin");
        fs::write(&source, b"matching").expect("source");
        fs::copy(&source, &destination).expect("copy");

        let result = verify_copy(&source, &destination).expect("verify");

        assert!(result.verified);
        assert_eq!(result.source_hash, result.destination_hash);

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
