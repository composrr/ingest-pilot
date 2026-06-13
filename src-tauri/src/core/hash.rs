use std::fs::File;
use std::io::Read;
use std::path::Path;

const HASH_BUFFER_SIZE: usize = 1024 * 1024;
const FNV_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;

pub fn stable_128_file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hash = FNV_OFFSET;
    let mut buffer = vec![0_u8; HASH_BUFFER_SIZE];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if bytes_read == 0 {
            break;
        }
        for byte in &buffer[..bytes_read] {
            hash ^= *byte as u128;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }

    Ok(format!("{hash:032x}"))
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

        let first = stable_128_file_hash(&path).expect("first hash");
        let second = stable_128_file_hash(&path).expect("second hash");

        assert_eq!(first, second);
        assert_eq!(first.len(), 32);

        let _ = fs::remove_file(path);
    }

    fn unique_temp_file(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("{prefix}_{suffix}.bin"))
    }
}
