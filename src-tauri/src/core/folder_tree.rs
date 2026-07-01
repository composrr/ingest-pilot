use crate::core::condition::folder_condition_matches;
use crate::core::preset::{FolderNode, Preset, TemplateFile, VariableDefault};
use crate::core::token::{resolve_pattern, TokenContext};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScaffoldResult {
    pub root_path: String,
    pub folders_created: usize,
    pub files_copied: usize,
    pub created_paths: Vec<String>,
}

pub fn scaffold_project(
    preset: &Preset,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
) -> Result<ScaffoldResult, String> {
    let destination = destination_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| preset.destinations.primary.clone());

    if destination.trim().is_empty() {
        return Err("Choose a destination before creating folders.".to_string());
    }

    let variable_values = values_with_defaults(preset, variable_values)?;
    let root_context = TokenContext {
        preset_name: Some(preset.name.clone()),
        variable_values: variable_values.clone(),
        clip_number_padding: Some(preset.clip_number_padding),
        ..TokenContext::default()
    };
    let root_name = resolve_pattern(&preset.root_folder_pattern, &root_context)?;
    let root_path = PathBuf::from(destination).join(root_name);

    let mut result = ScaffoldResult {
        root_path: root_path.to_string_lossy().to_string(),
        folders_created: 0,
        files_copied: 0,
        created_paths: Vec::new(),
    };

    create_directory(&root_path, &mut result)?;

    for folder in &preset.folder_tree {
        scaffold_folder(folder, &root_path, preset, &variable_values, &mut result)?;
    }

    Ok(result)
}

fn scaffold_folder(
    folder: &FolderNode,
    parent_path: &Path,
    preset: &Preset,
    variable_values: &BTreeMap<String, String>,
    result: &mut ScaffoldResult,
) -> Result<(), String> {
    if !folder_condition_matches(&folder.condition, variable_values) {
        return Ok(());
    }

    for expanded_values in expand_values_for_folder_pattern(&folder.name_pattern, variable_values) {
        let folder_context = TokenContext {
            preset_name: Some(preset.name.clone()),
            variable_values: expanded_values.clone(),
            clip_number_padding: Some(preset.clip_number_padding),
            ..TokenContext::default()
        };
        let folder_name = resolve_pattern(&folder.name_pattern, &folder_context)?;
        let folder_path = parent_path.join(&folder_name);
        create_directory(&folder_path, result)?;

        for template_file in &folder.template_files {
            copy_template_file(
                template_file,
                &folder_path,
                &folder_name,
                preset,
                &expanded_values,
                result,
            )?;
        }

        for child in &folder.children {
            scaffold_folder(child, &folder_path, preset, &expanded_values, result)?;
        }
    }

    Ok(())
}

fn copy_template_file(
    template_file: &TemplateFile,
    folder_path: &Path,
    folder_name: &str,
    preset: &Preset,
    variable_values: &BTreeMap<String, String>,
    result: &mut ScaffoldResult,
) -> Result<(), String> {
    let source_path = PathBuf::from(&template_file.source_path);
    if !source_path.is_file() {
        return Err(format!(
            "Template file '{}' is not available.",
            source_path.display()
        ));
    }

    let (original_name, extension) = file_stem_and_extension(&source_path);
    let rename_pattern = template_file
        .rename_pattern
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if template_file.name_from_folder {
            "{folder_name}{ext}"
        } else {
            "{original_name}{ext}"
        });
    let file_context = TokenContext {
        preset_name: Some(preset.name.clone()),
        variable_values: variable_values.clone(),
        clip_number_padding: Some(preset.clip_number_padding),
        original_name: Some(original_name),
        extension: Some(extension),
        folder_name: Some(folder_name.to_string()),
        ..TokenContext::default()
    };
    let target_name = resolve_pattern(rename_pattern, &file_context)?;
    let target_path = folder_path.join(target_name);

    fs::copy(&source_path, &target_path).map_err(|error| {
        format!(
            "{} -> {}: {error}",
            source_path.display(),
            target_path.display()
        )
    })?;
    result.files_copied += 1;
    result
        .created_paths
        .push(target_path.to_string_lossy().to_string());

    Ok(())
}

fn create_directory(path: &Path, result: &mut ScaffoldResult) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))?;
        result.folders_created += 1;
        result
            .created_paths
            .push(path.to_string_lossy().to_string());
    }

    Ok(())
}

fn values_with_defaults(
    preset: &Preset,
    mut variable_values: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    for variable in &preset.variables {
        let has_value = variable_values
            .get(&variable.id)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !has_value {
            if let Some(default) = &variable.default {
                variable_values.insert(variable.id.clone(), default_to_string(default));
            }
        }

        let has_value = variable_values
            .get(&variable.id)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if variable.required && !has_value {
            return Err(format!("{} is required.", variable.name));
        }
    }

    Ok(variable_values)
}

fn default_to_string(default: &VariableDefault) -> String {
    match default {
        VariableDefault::Text(value) => value.clone(),
        VariableDefault::Bool(value) => value.to_string(),
    }
}

fn file_stem_and_extension(path: &Path) -> (String, String) {
    let original_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Template")
        .to_string();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    (original_name, extension)
}

fn expand_values_for_folder_pattern(
    pattern: &str,
    variable_values: &BTreeMap<String, String>,
) -> Vec<BTreeMap<String, String>> {
    let mut expanded = vec![variable_values.clone()];

    for token in tokens_in_pattern(pattern) {
        let Some(value) = variable_values.get(&token) else {
            continue;
        };
        let parts = comma_separated_values(value);
        if parts.len() <= 1 {
            continue;
        }

        expanded = expanded
            .into_iter()
            .flat_map(|values| {
                let token = token.clone();
                parts.iter().map(move |part| {
                    let mut next = values.clone();
                    next.insert(token.clone(), part.clone());
                    next
                })
            })
            .collect();
    }

    expanded
}

fn comma_separated_values(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn tokens_in_pattern(pattern: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = pattern;

    while let Some(start) = rest.find('{') {
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('}') else {
            break;
        };
        let token = after_start[..end].trim();
        if !token.is_empty() && !tokens.iter().any(|candidate| candidate == token) {
            tokens.push(token.to_string());
        }
        rest = &after_start[end + 1..];
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::preset::{FolderRole, PresetDestinations, PresetVariable, VariableType};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn scaffolds_conditioned_folder_tree_and_template_file() {
        let workspace = unique_temp_dir("ingest_pilot_scaffold_test");
        let source_file = workspace.join("source").join("Template.prproj");
        fs::create_dir_all(source_file.parent().unwrap()).expect("source dir");
        fs::write(&source_file, "starter").expect("source file");
        let destination = workspace.join("output");
        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![
                PresetVariable {
                    id: "story_name".to_string(),
                    name: "Story Name".to_string(),
                    variable_type: VariableType::ShortText,
                    required: true,
                    default: None,
                    options: vec![],
                },
                PresetVariable {
                    id: "campus".to_string(),
                    name: "Campus".to_string(),
                    variable_type: VariableType::Dropdown,
                    required: false,
                    default: None,
                    options: vec!["KLR".to_string(), "MCK".to_string()],
                },
            ],
            root_folder_pattern: "{date}_{story_name}".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![FolderNode {
                    id: "folder_campus".to_string(),
                    name_pattern: "{campus}".to_string(),
                    is_footage_destination: true,
                    children: vec![],
                    template_files: vec![TemplateFile {
                        source_path: source_file.to_string_lossy().to_string(),
                        name_from_folder: true,
                        rename_pattern: Some("{folder_name}{ext}".to_string()),
                    }],
                    condition: None,
                    role: Some(FolderRole::Footage),
                }],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{folder_name}_{clip#}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = scaffold_project(
            &preset,
            BTreeMap::from([
                ("story_name".to_string(), "Johnson".to_string()),
                ("campus".to_string(), "KLR, MCK".to_string()),
            ]),
            None,
        )
        .expect("scaffold succeeds");

        assert!(PathBuf::from(&result.root_path)
            .join("Footage")
            .join("KLR")
            .exists());
        assert!(PathBuf::from(&result.root_path)
            .join("Footage")
            .join("KLR")
            .join("KLR.prproj")
            .exists());
        assert!(PathBuf::from(&result.root_path)
            .join("Footage")
            .join("MCK")
            .join("MCK.prproj")
            .exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn expands_comma_separated_folder_tokens() {
        let mut values = BTreeMap::new();
        values.insert("campus".to_string(), "KLR, MCK".to_string());
        let expanded = expand_values_for_folder_pattern("{campus}", &values);

        assert_eq!(expanded.len(), 2);
        assert_eq!(expanded[0].get("campus").map(String::as_str), Some("KLR"));
        assert_eq!(expanded[1].get("campus").map(String::as_str), Some("MCK"));
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("{prefix}_{suffix}"))
    }
}
