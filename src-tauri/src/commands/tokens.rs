use crate::core::token::{resolve_pattern, TokenContext};

#[tauri::command]
pub fn preview_pattern(pattern: String, context: TokenContext) -> Result<String, String> {
    resolve_pattern(&pattern, &context)
}
