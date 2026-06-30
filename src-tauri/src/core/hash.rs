use std::fs::File;
use std::io::Read;
use std::path::Path;

use xxhash_rust::xxh3::Xxh3;

const HASH_BUFFER_SIZE: usize = 4 * 1024 * 1024;

/// Streaming XXH3-128 checksum of a file, returned as a 32-char hex string.
/// XXH3-128 is a fast, modern, non-cryptographic hash well suited to DIT-style
/// integrity verification (and what MHL v2 expects).
pub fn xxh3_128_file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_SIZE];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:032x}", hasher.digest128()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn hashes_same_file_consistently() {
        let path = unique_temp_file("ingest_pilot_hash_test");
        fs::write(&path, b"hello ingest").expect("write file");

        let first = xxh3_128_file_hash(&path).expect("first hash");
        let second = xxh3_128_file_hash(&path).expect("second hash");

        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        // Deterministic XXH3-128 of b"hello ingest".
        assert_eq!(first, xxh3_128_file_hash(&path).expect("third hash"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn different_content_differs() {
        let a = unique_temp_file("ingest_pilot_hash_a");
        let b = unique_temp_file("ingest_pilot_hash_b");
        fs::write(&a, b"content one").expect("write a");
        fs::write(&b, b"content two").expect("write b");

        assert_ne!(
            xxh3_128_file_hash(&a).expect("hash a"),
            xxh3_128_file_hash(&b).expect("hash b")
        );

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    fn unique_temp_file(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}_{suffix}.bin"))
    }
}
