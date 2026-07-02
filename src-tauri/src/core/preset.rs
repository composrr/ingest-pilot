use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Preset {
    pub schema_version: u16,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub variables: Vec<PresetVariable>,
    pub root_folder_pattern: String,
    #[serde(default)]
    pub folder_tree: Vec<FolderNode>,
    pub file_rename_pattern: String,
    #[serde(default = "default_clip_number_padding")]
    pub clip_number_padding: u8,
    #[serde(default)]
    pub per_folder_rename_overrides: BTreeMap<String, String>,
    pub destinations: PresetDestinations,
    #[serde(default)]
    pub file_type_routing_overrides: BTreeMap<String, String>,
    #[serde(default = "default_preserve_sidecars")]
    pub preserve_xml_sidecars: bool,
    #[serde(default = "default_rename_files")]
    pub rename_files_default: bool,
    /// Optional metadata preset applied by default when this preset is chosen at ingest.
    #[serde(default)]
    pub metadata_preset_id: Option<String>,
    /// Preset-chosen metadata field values (field id -> value) pre-filled for imports
    /// made with this preset — so a preset can carry its own tags (e.g. Content
    /// Type=Story) without editing the shared metadata schema.
    #[serde(default)]
    pub metadata_values: BTreeMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub updated_at: String,
}

impl From<&Preset> for PresetSummary {
    fn from(preset: &Preset) -> Self {
        Self {
            id: preset.id.clone(),
            name: preset.name.clone(),
            description: preset.description.clone(),
            color: preset.color.clone(),
            updated_at: preset.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetVariable {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub variable_type: VariableType,
    pub required: bool,
    #[serde(default)]
    pub default: Option<VariableDefault>,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VariableType {
    ShortText,
    LongText,
    Dropdown,
    Boolean,
    Date,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum VariableDefault {
    Text(String),
    Bool(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FolderNode {
    pub id: String,
    pub name_pattern: String,
    #[serde(default)]
    pub is_footage_destination: bool,
    #[serde(default)]
    pub children: Vec<FolderNode>,
    #[serde(default)]
    pub template_files: Vec<TemplateFile>,
    #[serde(default)]
    pub condition: Option<FolderCondition>,
    #[serde(default)]
    pub role: Option<FolderRole>,
    /// Optional metadata preset attached to this folder. Clips routed into it (or a
    /// descendant without its own override) are tagged in the manifest with this
    /// preset's field defaults — so different campus folders under one root carry
    /// their own metadata in a single import.
    #[serde(default)]
    pub metadata_preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TemplateFile {
    pub source_path: String,
    #[serde(default = "default_name_from_folder")]
    pub name_from_folder: bool,
    #[serde(default)]
    pub rename_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FolderCondition {
    VariableHasValue {
        variable_id: String,
    },
    VariableEquals {
        variable_id: String,
        value: VariableDefault,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FolderRole {
    Footage,
    Audio,
    Photos,
    Documents,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetDestinations {
    pub primary: String,
    #[serde(default)]
    pub secondaries: Vec<String>,
    /// Optional tokenized sub-path inserted between the chosen destination and the
    /// project root folder, resolved per ingest (e.g. `{year}/Broll`). Lets a preset
    /// point at a stable parent (…/Videos) and descend into/create the current
    /// year's structure automatically. Segments are split on `/` and `\` and
    /// resolved individually; a segment that resolves empty is dropped.
    #[serde(default)]
    pub sub_path_pattern: String,
}

fn default_clip_number_padding() -> u8 {
    3
}

fn default_preserve_sidecars() -> bool {
    true
}

fn default_rename_files() -> bool {
    true
}

fn default_name_from_folder() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_preset_json() {
        let json = r##"
        {
          "schema_version": 1,
          "id": "preset_baptism_story",
          "name": "Baptism Story",
          "description": "Standard story ingest",
          "color": "#4F46E5",
          "variables": [
            {
              "id": "story_name",
              "name": "Story Name",
              "type": "short_text",
              "required": true,
              "default": ""
            },
            {
              "id": "include_audio",
              "name": "Include Audio",
              "type": "boolean",
              "required": false,
              "default": true
            }
          ],
          "root_folder_pattern": "{date}_BaptismStory_{story_name}",
          "folder_tree": [
            {
              "id": "folder_footage",
              "name_pattern": "Footage",
              "is_footage_destination": true,
              "role": "footage",
              "children": []
            }
          ],
          "file_rename_pattern": "{folder_name}_{camera}_{clip#}",
          "destinations": {
            "primary": "",
            "secondaries": []
          },
          "created_at": "2026-04-24T00:00:00Z",
          "updated_at": "2026-04-24T00:00:00Z"
        }
        "##;

        let preset: Preset = serde_json::from_str(json).expect("preset should parse");

        assert_eq!(preset.schema_version, 1);
        assert_eq!(preset.name, "Baptism Story");
        assert_eq!(preset.clip_number_padding, 3);
        assert!(preset.preserve_xml_sidecars);
        assert_eq!(preset.folder_tree[0].role, Some(FolderRole::Footage));
    }

    #[test]
    fn serializes_roundtrip() {
        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Test".to_string(),
            description: None,
            icon: None,
            color: Some("#c9a7ff".to_string()),
            variables: vec![],
            root_folder_pattern: "{date}_Test".to_string(),
            folder_tree: vec![],
            file_rename_pattern: "{original_name}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: String::new(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string_pretty(&preset).expect("preset serializes");
        let parsed: Preset = serde_json::from_str(&json).expect("preset parses");

        assert_eq!(parsed, preset);
    }
}
