use crate::ingest::copier::{CopiedFile, SkippedFile};
use crate::ingest::scanner::ScanFileKind;
use chrono::Local;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ReportInput<'a> {
    pub preset_name: &'a str,
    pub source_path: &'a str,
    pub root_path: &'a str,
    pub variable_values: &'a BTreeMap<String, String>,
    pub copied_files: &'a [CopiedFile],
    pub skipped_files: &'a [SkippedFile],
    pub files_copied: usize,
    pub verified_files: usize,
    pub verification_failed: usize,
    pub bytes_copied: u64,
    pub mhl_path: &'a str,
}

pub fn write_html_report(root_path: &Path, input: ReportInput<'_>) -> Result<PathBuf, String> {
    let project_name = project_name(root_path);
    let path = root_path.join(format!(
        "{}_IngestPilot_Report.html",
        sanitize_report_file_stem(&project_name)
    ));
    let generated_at = Local::now();
    let generated_label = generated_at.format("%b %-d, %Y %-I:%M %p").to_string();
    let status_ok = input.verification_failed == 0 && input.verified_files == input.files_copied;
    let kind_summary = summarize_kinds(input.copied_files);
    let deleted_sidecars = input
        .skipped_files
        .iter()
        .filter(|file| is_deleted_sidecar_skip(&file.reason))
        .collect::<Vec<_>>();
    let actionable_skipped_files = input
        .skipped_files
        .iter()
        .filter(|file| is_actionable_skip(&file.reason))
        .collect::<Vec<_>>();
    let hidden_skipped_count = input
        .skipped_files
        .len()
        .saturating_sub(actionable_skipped_files.len())
        .saturating_sub(deleted_sidecars.len());
    let source_count = split_sources(input.source_path).len();
    let destination_count = input
        .copied_files
        .iter()
        .filter_map(|file| Path::new(&file.destination_path).parent())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        .max(1);

    let mut html = String::new();
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\" />");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />");
    html.push_str("<title>Ingest Pilot Report</title>");
    html.push_str("<style>");
    html.push_str(":root{color-scheme:light;--ink:#151413;--graphite:#5f5a52;--muted:#8a8378;--line:#e7e0d6;--paper:#f7f5ef;--panel:#fff;--soft:#fbfaf7;--ok:#58bf72;--ok-bg:#e6f8ea;--bad:#b94343;--bad-bg:#ffe5e5;--accent:#9d77ea;--accent-bg:#efe6ff;--blue:#5278b8}");
    html.push_str("*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.35}");
    html.push_str("main{max-width:1280px;margin:22px auto;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 18px 70px rgba(26,22,16,.08);overflow:hidden}");
    html.push_str("header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start;padding:18px 22px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fff,#fbfaf7)}h1{margin:0;font-size:24px;letter-spacing:0}.eyebrow{font-size:11px;font-weight:800;color:var(--graphite);text-transform:uppercase;letter-spacing:.04em}.sub{margin:5px 0 0;color:var(--graphite);font-weight:650}.status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:850}.status.ok{background:var(--ok-bg);color:#176b35}.status.bad{background:var(--bad-bg);color:#982626}.dot{width:8px;height:8px;border-radius:99px;background:currentColor}");
    html.push_str(".summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;padding:12px;border-bottom:1px solid var(--line);background:#fff}.tile{border:1px solid var(--line);border-radius:10px;background:var(--soft);padding:9px 10px;min-width:0}.label{font-size:10px;font-weight:850;color:var(--graphite);text-transform:uppercase;letter-spacing:.035em}.value{margin-top:4px;font-size:18px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.value.small{font-size:13px}");
    html.push_str(".content{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:620px}.side{border-right:1px solid var(--line);background:var(--soft)}section{padding:14px 16px;border-bottom:1px solid var(--line)}h2{margin:0 0 10px;font-size:13px}.kv{display:grid;grid-template-columns:84px minmax(0,1fr);gap:6px 8px}.k{color:var(--graphite);font-weight:800}.v{min-width:0;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.chip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;padding:3px 7px;margin:0 5px 5px 0;font-size:11px;font-weight:750}");
    html.push_str(".kind{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;background:#fff;padding:8px;margin-bottom:7px}.bar{height:7px;border-radius:99px;background:#eee8df;overflow:hidden;margin-top:5px}.bar span{display:block;height:100%;background:var(--accent)}.main{min-width:0;background:#fff}.strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:12px;border-bottom:1px solid var(--line)}.strip-card{border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}");
    html.push_str(".files{padding:12px}.file{display:grid;grid-template-columns:116px minmax(0,1fr) 150px;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;background:#fff;margin-bottom:8px;padding:8px}.thumb{width:116px;height:66px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#f1ede6}.empty-thumb{width:116px;height:66px;border:1px dashed #d8d0c4;border-radius:8px;background:var(--soft);display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:800;font-size:10px}.file-name{font-size:13px;font-weight:850;margin-bottom:2px}.file-path{font-size:11px;color:var(--graphite);word-break:break-all}.file-meta{text-align:right;display:grid;gap:4px}.ok-text{color:#176b35;font-weight:850}.bad-text{color:#982626;font-weight:850}.muted{color:var(--graphite)}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;word-break:break-all}");
    html.push_str("table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid var(--line);padding:7px;text-align:left;vertical-align:top}th{color:var(--graphite);font-size:10px;text-transform:uppercase;letter-spacing:.03em}.footer{padding:10px 16px;color:var(--graphite);font-size:11px;background:var(--soft)}");
    html.push_str("@media(max-width:960px){main{margin:0;border-radius:0}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.content{grid-template-columns:1fr}.side{border-right:0}.strip{grid-template-columns:1fr}.file{grid-template-columns:1fr}.file-meta{text-align:left}}");
    html.push_str("</style></head><body><main>");

    html.push_str("<header><div><div class=\"eyebrow\">Ingest Pilot Verification Report</div>");
    html.push_str("<h1>");
    html.push_str(&escape_html(&project_name));
    html.push_str("</h1><p class=\"sub\">Generated ");
    html.push_str(&escape_html(&generated_label));
    html.push_str(" / Preset ");
    html.push_str(&escape_html(input.preset_name));
    html.push_str("</p></div>");
    html.push_str(if status_ok {
        "<span class=\"status ok\"><span class=\"dot\"></span>Verified</span>"
    } else {
        "<span class=\"status bad\"><span class=\"dot\"></span>Needs Review</span>"
    });
    html.push_str("</header>");

    html.push_str("<div class=\"summary\">");
    tile(&mut html, "Copied", &input.files_copied.to_string(), false);
    tile(
        &mut html,
        "Verified",
        &format!("{}/{}", input.verified_files, input.files_copied),
        false,
    );
    tile(
        &mut html,
        "Failures",
        &input.verification_failed.to_string(),
        false,
    );
    tile(
        &mut html,
        "Total Size",
        &format_bytes(input.bytes_copied),
        false,
    );
    tile(&mut html, "Sources", &source_count.to_string(), false);
    tile(&mut html, "Folders", &destination_count.to_string(), false);
    html.push_str("</div>");

    html.push_str("<div class=\"content\"><aside class=\"side\">");
    html.push_str("<section><h2>Job Details</h2><div class=\"kv\">");
    kv(&mut html, "Source", input.source_path);
    kv(&mut html, "Destination", input.root_path);
    kv(&mut html, "MHL", input.mhl_path);
    kv(&mut html, "Hash", "XXH3-128 verification hash");
    html.push_str("</div></section>");

    html.push_str("<section><h2>Parameters</h2>");
    if input.variable_values.is_empty() {
        html.push_str("<div class=\"muted\">No parameters used.</div>");
    } else {
        for (key, value) in input.variable_values {
            html.push_str("<span class=\"chip\"><code>{");
            html.push_str(&escape_html(key));
            html.push_str("}</code>&nbsp;");
            html.push_str(&escape_html(value));
            html.push_str("</span>");
        }
    }
    html.push_str("</section>");

    html.push_str("<section><h2>Copied By Type</h2>");
    for summary in &kind_summary {
        let percent = if input.bytes_copied == 0 {
            0.0
        } else {
            (summary.bytes as f64 / input.bytes_copied as f64) * 100.0
        };
        html.push_str("<div class=\"kind\"><div><strong>");
        html.push_str(kind_label(summary.kind));
        html.push_str("</strong><div class=\"bar\"><span style=\"width:");
        html.push_str(&format!("{percent:.2}%"));
        html.push_str("\"></span></div></div><div class=\"muted\">");
        html.push_str(&summary.count.to_string());
        html.push_str(" / ");
        html.push_str(&format_bytes(summary.bytes));
        html.push_str("</div></div>");
    }
    html.push_str("</section></aside><div class=\"main\">");

    html.push_str("<div class=\"strip\">");
    strip_card(
        &mut html,
        "Verification",
        if status_ok {
            "All copied files match"
        } else {
            "Some files need review"
        },
    );
    strip_card(
        &mut html,
        "Report Assets",
        &format!(
            "{} thumbnails linked",
            input
                .copied_files
                .iter()
                .filter(|file| file.thumbnail_path.is_some())
                .count()
        ),
    );
    strip_card(
        &mut html,
        "Deleted Sidecars",
        &format!("{} recorded", deleted_sidecars.len()),
    );
    html.push_str("</div>");

    html.push_str("<section><h2>Copied Files</h2></section><div class=\"files\">");
    for file in input.copied_files {
        render_file(&mut html, file);
    }
    if input.copied_files.is_empty() {
        html.push_str("<div class=\"muted\">No files were copied.</div>");
    }
    html.push_str("</div>");

    if !actionable_skipped_files.is_empty() {
        html.push_str("<section><h2>Skipped Files Needing Review</h2><table><thead><tr><th>Reason</th><th>Source</th></tr></thead><tbody>");
        for file in actionable_skipped_files {
            html.push_str("<tr><td>");
            html.push_str(&escape_html(&file.reason));
            html.push_str("</td><td><code>");
            html.push_str(&escape_html(&file.source_path));
            html.push_str("</code></td></tr>");
        }
        html.push_str("</tbody></table></section>");
    }
    if !deleted_sidecars.is_empty() {
        html.push_str("<section><h2>Deleted Sidecars</h2><div class=\"muted\" style=\"margin-bottom:8px\">These sidecar files were intentionally not copied because Delete sidecars was enabled.</div><table><thead><tr><th>Sidecar</th><th>Source</th></tr></thead><tbody>");
        for file in deleted_sidecars {
            html.push_str("<tr><td>");
            html.push_str(&escape_html(&file_name(&file.source_path)));
            html.push_str("</td><td><code>");
            html.push_str(&escape_html(&file.source_path));
            html.push_str("</code></td></tr>");
        }
        html.push_str("</tbody></table></section>");
    }
    if hidden_skipped_count > 0 {
        html.push_str("<section><div class=\"muted\">");
        html.push_str(&hidden_skipped_count.to_string());
        html.push_str(" routine skipped item");
        if hidden_skipped_count != 1 {
            html.push('s');
        }
        html.push_str(" hidden from this report, such as unselected files or system files ignored by the scanner.</div></section>");
    }

    html.push_str("</div></div><div class=\"footer\">Generated by Ingest Pilot. Keep this report with the project folder for delivery and audit records.</div>");
    html.push_str("</main></body></html>");

    fs::write(&path, html).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

#[derive(Debug)]
struct KindReportSummary {
    kind: ScanFileKind,
    count: usize,
    bytes: u64,
}

fn summarize_kinds(files: &[CopiedFile]) -> Vec<KindReportSummary> {
    let mut summaries = BTreeMap::<ScanFileKind, KindReportSummary>::new();
    for file in files {
        let summary = summaries.entry(file.kind).or_insert(KindReportSummary {
            kind: file.kind,
            count: 0,
            bytes: 0,
        });
        summary.count += 1;
        summary.bytes += file.size_bytes;
    }
    summaries.into_values().collect()
}

fn render_file(html: &mut String, file: &CopiedFile) {
    html.push_str("<article class=\"file\"><div>");
    if let Some(thumbnail_path) = file.thumbnail_path.as_ref() {
        html.push_str("<img class=\"thumb\" alt=\"thumbnail\" src=\"");
        html.push_str(&escape_html(&thumbnail_path.replace('\\', "/")));
        html.push_str("\" />");
    } else {
        html.push_str("<div class=\"empty-thumb\">No thumbnail</div>");
    }
    html.push_str("</div><div><div class=\"file-name\">");
    html.push_str(&escape_html(&file_name(&file.destination_path)));
    html.push_str("</div><div class=\"file-path\">");
    html.push_str(&escape_html(&file.destination_path));
    html.push_str("</div><div class=\"file-path muted\">Source: ");
    html.push_str(&escape_html(&file.source_path));
    html.push_str("</div></div><div class=\"file-meta\"><div>");
    html.push_str(if file.verified {
        "<span class=\"ok-text\">Verified</span>"
    } else {
        "<span class=\"bad-text\">Failed</span>"
    });
    html.push_str("</div><div class=\"muted\">");
    html.push_str(kind_label(file.kind));
    html.push_str(" / ");
    html.push_str(&format_bytes(file.size_bytes));
    html.push_str("</div><code>");
    html.push_str(&escape_html(&file.destination_hash));
    html.push_str("</code></div></article>");
}

fn is_actionable_skip(reason: &str) -> bool {
    !matches!(
        reason,
        "Not selected for this ingest."
            | "Sidecar deletion is enabled."
            | "Matching media file was not copied."
            | "System/cache file ignored by default."
            | "Unsupported file type."
    )
}

fn is_deleted_sidecar_skip(reason: &str) -> bool {
    reason == "Sidecar deletion is enabled."
}

fn tile(html: &mut String, label: &str, value: &str, small: bool) {
    html.push_str("<div class=\"tile\"><div class=\"label\">");
    html.push_str(&escape_html(label));
    html.push_str("</div><div class=\"value");
    if small {
        html.push_str(" small");
    }
    html.push_str("\">");
    html.push_str(&escape_html(value));
    html.push_str("</div></div>");
}

fn strip_card(html: &mut String, label: &str, value: &str) {
    html.push_str("<div class=\"strip-card\"><div class=\"label\">");
    html.push_str(&escape_html(label));
    html.push_str("</div><div class=\"value small\">");
    html.push_str(&escape_html(value));
    html.push_str("</div></div>");
}

fn kv(html: &mut String, label: &str, value: &str) {
    html.push_str("<div class=\"k\">");
    html.push_str(&escape_html(label));
    html.push_str("</div><div class=\"v\">");
    html.push_str(&escape_html(value));
    html.push_str("</div>");
}

fn kind_label(kind: ScanFileKind) -> &'static str {
    match kind {
        ScanFileKind::Footage => "Footage",
        ScanFileKind::Photo => "Photos",
        ScanFileKind::Audio => "Audio",
        ScanFileKind::Document => "Documents",
        ScanFileKind::Sidecar => "Sidecars",
        ScanFileKind::Unknown => "Unknown",
        ScanFileKind::Ignored => "Ignored",
    }
}

fn split_sources(value: &str) -> Vec<&str> {
    value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn project_name(root_path: &Path) -> String {
    root_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("IngestPilot_Project")
        .to_string()
}

fn sanitize_report_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if sanitized.is_empty() {
        "IngestPilot_Project".to_string()
    } else {
        sanitized
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    let precision = if value >= 10.0 { 1 } else { 2 };
    format!("{value:.precision$} {}", units[index])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_html_report() {
        let workspace = unique_temp_dir("ingest_pilot_report_test");
        fs::create_dir_all(&workspace).expect("workspace");
        let copied = vec![CopiedFile {
            source_path: "P:/A001.mp4".to_string(),
            destination_path: workspace
                .join("Footage/A001.mp4")
                .to_string_lossy()
                .to_string(),
            kind: ScanFileKind::Footage,
            size_bytes: 24,
            thumbnail_path: None,
            source_hash: "abc123".to_string(),
            destination_hash: "abc123".to_string(),
            verified: true,
            duration_ms: None,
        }];

        let path = write_html_report(
            &workspace,
            ReportInput {
                preset_name: "Baptism Story",
                source_path: "P:/",
                root_path: &workspace.to_string_lossy(),
                variable_values: &BTreeMap::from([("campus".to_string(), "KLR".to_string())]),
                copied_files: &copied,
                skipped_files: &[],
                files_copied: 1,
                verified_files: 1,
                verification_failed: 0,
                bytes_copied: 24,
                mhl_path: "IngestPilot.mhl",
            },
        )
        .expect("report writes");

        let html = fs::read_to_string(path).expect("report readable");
        assert!(html.contains("Ingest Pilot Verification Report"));
        assert!(html.contains("ingest_pilot_report_test"));
        assert!(html.contains("Preset Baptism Story"));
        assert!(html.contains("A001.mp4"));
        assert!(html.contains("Copied By Type"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn names_report_after_project_folder() {
        let workspace = unique_temp_dir("Project Alpha");
        fs::create_dir_all(&workspace).expect("workspace");

        let path = write_html_report(
            &workspace,
            ReportInput {
                preset_name: "Interview",
                source_path: "P:/",
                root_path: &workspace.to_string_lossy(),
                variable_values: &BTreeMap::new(),
                copied_files: &[],
                skipped_files: &[],
                files_copied: 0,
                verified_files: 0,
                verification_failed: 0,
                bytes_copied: 0,
                mhl_path: "IngestPilot.mhl",
            },
        )
        .expect("report writes");

        assert!(path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("filename")
            .ends_with("_IngestPilot_Report.html"));
        assert!(path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("filename")
            .starts_with("Project_Alpha"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn hides_routine_skips_from_report_details() {
        let workspace = unique_temp_dir("ingest_pilot_report_skip_test");
        fs::create_dir_all(&workspace).expect("workspace");
        let skipped = vec![
            SkippedFile {
                source_path: "P:/TODAY/A002.mp4".to_string(),
                reason: "Not selected for this ingest.".to_string(),
            },
            SkippedFile {
                source_path: "P:/TODAY/A002.XML".to_string(),
                reason: "Sidecar deletion is enabled.".to_string(),
            },
            SkippedFile {
                source_path: "P:/BROKEN/A003.mp4".to_string(),
                reason: "No matching target folder.".to_string(),
            },
        ];

        let path = write_html_report(
            &workspace,
            ReportInput {
                preset_name: "Baptism Story",
                source_path: "P:/",
                root_path: &workspace.to_string_lossy(),
                variable_values: &BTreeMap::new(),
                copied_files: &[],
                skipped_files: &skipped,
                files_copied: 0,
                verified_files: 0,
                verification_failed: 0,
                bytes_copied: 0,
                mhl_path: "IngestPilot.mhl",
            },
        )
        .expect("report writes");

        let html = fs::read_to_string(path).expect("report readable");
        assert!(html.contains("No matching target folder."));
        assert!(!html.contains("Not selected for this ingest."));
        assert!(html.contains("Deleted Sidecars"));
        assert!(html.contains("A002.XML"));
        assert!(html.contains("1 routine skipped item hidden"));

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
