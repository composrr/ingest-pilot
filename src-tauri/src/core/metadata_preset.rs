use serde::{Deserialize, Serialize};

/// A reusable set of shoot-level metadata fields (Lightroom-style), grouped into
/// named categories that mirror the team's iconik metadata view. At ingest the
/// operator fills one value per field and every clip in the import is tagged with
/// the same values, written out as a CSV manifest for bulk import into iconik.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataPreset {
    #[serde(default = "default_schema_version")]
    pub schema_version: u16,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub categories: Vec<MetadataCategory>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataCategory {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub fields: Vec<MetadataField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataField {
    /// Stable key used as the CSV column header (maps to the iconik field name).
    pub id: String,
    pub label: String,
    pub field_type: MetadataFieldType,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetadataFieldType {
    Text,
    LongText,
    Dropdown,
    MultiSelect,
    Boolean,
    Date,
    /// Who shot the video. Options come from the shared Shooters roster (Settings)
    /// rather than per-field options, and it defaults to this machine's operator.
    Shooter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataPresetSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub field_count: usize,
}

impl From<&MetadataPreset> for MetadataPresetSummary {
    fn from(preset: &MetadataPreset) -> Self {
        Self {
            id: preset.id.clone(),
            name: preset.name.clone(),
            description: preset.description.clone(),
            field_count: preset
                .categories
                .iter()
                .map(|category| category.fields.len())
                .sum(),
        }
    }
}

fn default_schema_version() -> u16 {
    1
}
