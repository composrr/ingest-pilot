use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use printpdf::{
    BuiltinFont, ColorBits, ColorSpace, Image, ImageTransform, ImageXObject, Mm, PdfDocument, Px,
};

use crate::ingest::copier::CopiedFile;

/// Cap on how many thumbnails the proof embeds (keeps the PDF small and the layout tidy).
const MAX_PDF_THUMBS: usize = 6;

pub struct OffloadProofInput<'a> {
    pub root_path: &'a str,
    /// Directory the PDF is written to (defaults to root_path when None).
    pub output_dir: Option<&'a str>,
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

    // Preview strip: embed up to MAX_PDF_THUMBS thumbnails (resolved from each file's
    // root-relative `thumbnail_path`). Decoded + downscaled with the `image` crate and
    // placed as raw RGB ImageXObjects so we don't depend on printpdf's image version.
    // Decode *before* the cap so a run whose first entries are non-embeddable (e.g. a
    // passthrough .webp/.gif thumbnail the jpeg/png-only decoder rejects) still fills the
    // strip with the first MAX_PDF_THUMBS decodable previews rather than rendering empty.
    let root = Path::new(input.root_path);
    let previews: Vec<(ImageXObject, u32, u32)> = input
        .copied_files
        .iter()
        .filter_map(|file| file.thumbnail_path.as_ref())
        .map(|relative| root.join(relative.replace('\\', "/")))
        .filter(|path| path.is_file())
        .filter_map(|path| load_thumbnail_xobject(&path, 200))
        .take(MAX_PDF_THUMBS)
        .collect();
    if !previews.is_empty() {
        y -= 3.0;
        current.use_text("Preview", 11.0, Mm(18.0), Mm(y), &bold);
        y -= 4.0;
        let cell_w = 30.0_f32; // horizontal pitch per thumbnail, mm
        let cell_h = 18.0_f32; // image box height, mm
        let strip_top = y; // images hang down from here
        for (index, (xobject, pixel_w, pixel_h)) in previews.into_iter().enumerate() {
            let dpi = 300.0_f32;
            let image_w_pt = (pixel_w as f32) / dpi * 72.0;
            let image_h_pt = (pixel_h as f32) / dpi * 72.0;
            let target_w_pt = (cell_w - 3.0) * 72.0 / 25.4;
            let target_h_pt = cell_h * 72.0 / 25.4;
            let scale = (target_w_pt / image_w_pt).min(target_h_pt / image_h_pt);
            let draw_h_mm = image_h_pt * scale / 72.0 * 25.4;
            let x_mm = 18.0 + (index as f32) * cell_w;
            let y_mm = strip_top - draw_h_mm;
            Image::from(xobject).add_to_layer(
                current.clone(),
                ImageTransform {
                    translate_x: Some(Mm(x_mm)),
                    translate_y: Some(Mm(y_mm)),
                    scale_x: Some(scale),
                    scale_y: Some(scale),
                    dpi: Some(dpi),
                    ..Default::default()
                },
            );
        }
        y = strip_top - cell_h - 3.0;
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
    let dir = input.output_dir.unwrap_or(input.root_path);
    let _ = std::fs::create_dir_all(dir);
    let out_path = Path::new(dir).join(format!("{project_name}_OffloadProof.pdf"));
    doc.save(&mut BufWriter::new(
        File::create(&out_path).map_err(|error| format!("{}: {error}", out_path.display()))?,
    ))
    .map_err(|error| error.to_string())?;
    Ok(out_path)
}

/// Decode a thumbnail file (jpeg/png), downscale to fit within `box_px`, and build a
/// raw-RGB `ImageXObject` for printpdf. Returns the xobject plus its pixel dimensions.
/// Any decode failure (e.g. a passthrough .webp thumbnail) yields None → skipped.
fn load_thumbnail_xobject(path: &Path, box_px: u32) -> Option<(ImageXObject, u32, u32)> {
    let image = image::open(path).ok()?.thumbnail(box_px, box_px);
    let rgb = image.to_rgb8();
    let (width, height) = (rgb.width(), rgb.height());
    let xobject = ImageXObject {
        width: Px(width as usize),
        height: Px(height as usize),
        color_space: ColorSpace::Rgb,
        bits_per_component: ColorBits::Bit8,
        interpolate: false,
        image_data: rgb.into_raw(),
        image_filter: None,
        smask: None,
        clipping_bbox: None,
    };
    Some((xobject, width, height))
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
