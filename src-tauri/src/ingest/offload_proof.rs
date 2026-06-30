use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use printpdf::{BuiltinFont, Mm, PdfDocument};

use crate::ingest::copier::CopiedFile;

pub struct OffloadProofInput<'a> {
    pub root_path: &'a str,
    pub preset_name: &'a str,
    pub source_paths: &'a [String],
    pub destination_paths: &'a [String],
    pub copied_files: &'a [CopiedFile],
    pub files_copied: usize,
    pub verified_files: usize,
    pub verification_failed: usize,
    pub bytes_copied: u64,
    pub operator: &'a str,
    pub generated_at: &'a str,
}

const PAGE_W: f32 = 210.0;
const PAGE_H: f32 = 297.0;
const MAX_FILE_ROWS: usize = 32;

/// Render a printable PDF "offload integrity proof" to the project root and
/// return its path. Captures operator, timestamp, destinations, the hash
/// algorithm, the verification summary, and a per-file hash/verify list.
pub fn write_offload_proof(input: OffloadProofInput<'_>) -> Result<PathBuf, String> {
    let (doc, page, layer) =
        PdfDocument::new("Offload Integrity Proof", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let regular = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|error| error.to_string())?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|error| error.to_string())?;
    let mono = doc
        .add_builtin_font(BuiltinFont::Courier)
        .map_err(|error| error.to_string())?;
    let current = doc.get_page(page).get_layer(layer);

    current.use_text("Offload Integrity Proof", 20.0, Mm(18.0), Mm(278.0), &bold);
    current.use_text(
        "Ingest Pilot — XXH3-128 verified copy",
        10.0,
        Mm(18.0),
        Mm(270.0),
        &regular,
    );

    let status = if input.verification_failed == 0 {
        "ALL COPIES VERIFIED — BIT-IDENTICAL"
    } else {
        "VERIFICATION FAILURES PRESENT"
    };
    current.use_text(status, 12.0, Mm(18.0), Mm(260.0), &bold);

    let operator = if input.operator.trim().is_empty() {
        "(unspecified)"
    } else {
        input.operator
    };
    let summary = format!(
        "{} files · {} verified · {} failed · {}",
        input.files_copied,
        input.verified_files,
        input.verification_failed,
        format_bytes(input.bytes_copied),
    );

    let rows: [(&str, &str); 8] = [
        ("Generated", input.generated_at),
        ("Operator", operator),
        ("Preset", input.preset_name),
        ("Project", input.root_path),
        ("Sources", &input.source_paths.join("; ")),
        ("Destinations", &input.destination_paths.join("; ")),
        ("Hash", "XXH3-128"),
        ("Summary", &summary),
    ];
    let mut y = 248.0_f32;
    for (label, value) in rows {
        current.use_text(label, 10.0, Mm(18.0), Mm(y), &bold);
        current.use_text(truncate(value, 92), 10.0, Mm(50.0), Mm(y), &regular);
        y -= 7.0;
    }

    y -= 3.0;
    current.use_text("Files", 11.0, Mm(18.0), Mm(y), &bold);
    y -= 6.0;
    for file in input.copied_files.iter().take(MAX_FILE_ROWS) {
        let name = Path::new(&file.destination_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&file.destination_path);
        let mark = if file.verified { "OK" } else { "X " };
        let row = format!(
            "{mark}  {:<30}  {}",
            truncate(name, 30),
            short_hash(&file.destination_hash),
        );
        current.use_text(row, 8.0, Mm(18.0), Mm(y), &mono);
        y -= 4.6;
        if y < 16.0 {
            break;
        }
    }
    if input.copied_files.len() > MAX_FILE_ROWS && y >= 16.0 {
        current.use_text(
            format!(
                "… and {} more (full list in the MHL + HTML report)",
                input.copied_files.len() - MAX_FILE_ROWS
            ),
            8.0,
            Mm(18.0),
            Mm(y),
            &regular,
        );
    }

    let project_name = Path::new(input.root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("IngestPilot");
    let out_path = Path::new(input.root_path).join(format!("{project_name}_OffloadProof.pdf"));
    doc.save(&mut BufWriter::new(
        File::create(&out_path).map_err(|error| format!("{}: {error}", out_path.display()))?,
    ))
    .map_err(|error| error.to_string())?;
    Ok(out_path)
}

fn short_hash(hash: &str) -> String {
    if hash.len() <= 16 {
        hash.to_string()
    } else {
        format!("{}…", &hash[..16])
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        let kept: String = value.chars().take(max.saturating_sub(1)).collect();
        format!("{kept}…")
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
