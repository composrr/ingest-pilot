use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TokenContext {
    #[serde(default)]
    pub preset_name: Option<String>,
    #[serde(default)]
    pub variable_values: BTreeMap<String, String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub camera: Option<String>,
    #[serde(default)]
    pub clip_number: Option<u32>,
    #[serde(default)]
    pub clip_number_padding: Option<u8>,
    #[serde(default)]
    pub original_name: Option<String>,
    #[serde(default)]
    pub capture_date: Option<String>,
    #[serde(default)]
    pub extension: Option<String>,
    #[serde(default)]
    pub folder_name: Option<String>,
}

pub fn resolve_pattern(pattern: &str, context: &TokenContext) -> Result<String, String> {
    let mut output = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '{' {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let start = index;
        let Some(end) = chars[index + 1..]
            .iter()
            .position(|character| *character == '}')
        else {
            return Err(format!(
                "Unclosed token starting at character {}.",
                start + 1
            ));
        };
        let end = index + 1 + end;
        let token: String = chars[index + 1..end].iter().collect();
        output.push_str(&resolve_token(&token, context)?);
        index = end + 1;
    }

    Ok(collapse_separators(&sanitize_path_component(&output)))
}

/// Collapses runs of separator characters (`_` / `-`) down to a single one and
/// trims them from the ends. This is what makes optional tokens "clean": when a
/// blank token resolves to an empty string, the separators that were meant to sit
/// on either side of it fold together (e.g. `Date_{blank}_Story` -> `Date_Story`,
/// `Date_{blank}` -> `Date`) instead of leaving a stray or trailing underscore.
fn collapse_separators(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut previous_was_separator = false;
    for character in value.chars() {
        let is_separator = character == '_' || character == '-';
        if is_separator && previous_was_separator {
            continue;
        }
        result.push(character);
        previous_was_separator = is_separator;
    }
    result
        .trim_matches(|character| character == '_' || character == '-' || character == ' ')
        .to_string()
}

fn resolve_token(token: &str, context: &TokenContext) -> Result<String, String> {
    let date_parts = DateParts::from_context(context);

    match token {
        "date" => Ok(date_parts.date),
        "year" => Ok(date_parts.year),
        "month" => Ok(date_parts.month),
        "day" => Ok(date_parts.day),
        "preset_name" => optional_token(token, &context.preset_name),
        "camera" => optional_token(token, &context.camera),
        "clip#" => {
            let clip_number = context
                .clip_number
                .ok_or_else(|| "Token '{clip#}' needs a clip number.".to_string())?;
            let padding = context.clip_number_padding.unwrap_or(3) as usize;
            Ok(format!("{clip_number:0padding$}"))
        }
        "original_name" => optional_token(token, &context.original_name),
        "capture_date" => optional_token(token, &context.capture_date),
        "ext" => optional_token(token, &context.extension),
        "folder_name" => optional_token(token, &context.folder_name),
        variable_id => context
            .variable_values
            .get(variable_id)
            .cloned()
            .ok_or_else(|| format!("Unknown token '{{{variable_id}}}'.")),
    }
}

fn optional_token(token: &str, value: &Option<String>) -> Result<String, String> {
    value
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("Token '{{{token}}}' has no value."))
}

fn sanitize_path_component(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    for character in value.chars() {
        let invalid = matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        ) || character.is_control();
        sanitized.push(if invalid { '_' } else { character });
    }

    let trimmed = sanitized.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed
    }
}

struct DateParts {
    date: String,
    year: String,
    month: String,
    day: String,
}

impl DateParts {
    fn from_context(context: &TokenContext) -> Self {
        if let Some(date) = &context.date {
            if date.len() >= 10 {
                let year = date[0..4].to_string();
                let month = date[5..7].to_string();
                let day = date[8..10].to_string();
                return Self {
                    date: format!("{year}{month}{day}"),
                    year,
                    month,
                    day,
                };
            }
        }

        let today = Local::now().date_naive();
        Self {
            date: today.format("%Y%m%d").to_string(),
            year: format!("{:04}", today.year()),
            month: format!("{:02}", today.month()),
            day: format!("{:02}", today.day()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_context() -> TokenContext {
        TokenContext {
            preset_name: Some("Baptism Story".to_string()),
            variable_values: BTreeMap::from([
                ("story_name".to_string(), "Johnson".to_string()),
                ("campus".to_string(), "KLR".to_string()),
            ]),
            date: Some("2026-04-24".to_string()),
            camera: Some("FX3".to_string()),
            clip_number: Some(7),
            clip_number_padding: Some(3),
            original_name: Some("C0007".to_string()),
            capture_date: Some("20260423".to_string()),
            extension: Some(".MP4".to_string()),
            folder_name: Some("Footage".to_string()),
        }
    }

    #[test]
    fn resolves_global_and_variable_tokens() {
        let output = resolve_pattern("{date}_Baptism_{story_name}_{campus}", &sample_context())
            .expect("pattern resolves");

        assert_eq!(output, "20260424_Baptism_Johnson_KLR");
    }

    #[test]
    fn resolves_clip_tokens_with_padding() {
        let output = resolve_pattern(
            "{folder_name}_{camera}_{clip#}_{original_name}{ext}",
            &sample_context(),
        )
        .expect("pattern resolves");

        assert_eq!(output, "Footage_FX3_007_C0007.MP4");
    }

    #[test]
    fn returns_unknown_token_error() {
        let error = resolve_pattern("{missing}", &sample_context()).expect_err("should fail");

        assert!(error.contains("Unknown token"));
    }

    #[test]
    fn sanitizes_windows_unsafe_characters() {
        let mut context = sample_context();
        context
            .variable_values
            .insert("story_name".to_string(), "John:son/Smith?".to_string());

        let output = resolve_pattern("{story_name}", &context).expect("pattern resolves");

        // Sanitized separators collapse and the trailing one is trimmed.
        assert_eq!(output, "John_son_Smith");
    }

    #[test]
    fn drops_separator_for_blank_optional_token() {
        let mut context = sample_context();
        // An optional descriptor variable the user left blank.
        context
            .variable_values
            .insert("descriptor".to_string(), String::new());

        // Blank token in the middle: the two underscores fold into one.
        let middle = resolve_pattern("{date}_{descriptor}_{story_name}", &context)
            .expect("pattern resolves");
        assert_eq!(middle, "20260424_Johnson");

        // Blank token at the end: no trailing underscore is left behind.
        let trailing =
            resolve_pattern("{date}_{story_name}_{descriptor}", &context).expect("pattern resolves");
        assert_eq!(trailing, "20260424_Johnson");
    }

    #[test]
    fn resolves_date_parts() {
        let output =
            resolve_pattern("{year}-{month}-{day}", &sample_context()).expect("pattern resolves");

        assert_eq!(output, "2026-04-24");
    }
}
