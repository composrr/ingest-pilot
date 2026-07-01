export type VariableType = "short_text" | "long_text" | "dropdown" | "boolean" | "date";

// Metadata presets (Lightroom-style): reusable shoot-level metadata schemas.
export type MetadataFieldType = "text" | "long_text" | "dropdown" | "multi_select" | "boolean" | "date";

export type MetadataField = {
  id: string;
  label: string;
  field_type: MetadataFieldType;
  options: string[];
  default?: string | null;
};

export type MetadataCategory = {
  id: string;
  name: string;
  fields: MetadataField[];
};

export type MetadataPreset = {
  schema_version: number;
  id: string;
  name: string;
  description?: string | null;
  categories: MetadataCategory[];
  created_at: string;
  updated_at: string;
};

export type MetadataPresetSummary = {
  id: string;
  name: string;
  description?: string | null;
  field_count: number;
};

export type PresetVariable = {
  id: string;
  name: string;
  type: VariableType;
  required: boolean;
  default?: string | boolean | null;
  options: string[];
};

export type FolderRole = "footage" | "audio" | "photos" | "documents" | "other";

export type FolderCondition =
  | {
      type: "variable_has_value";
      variable_id: string;
    }
  | {
      type: "variable_equals";
      variable_id: string;
      value: string | boolean;
    };

export type TemplateFile = {
  source_path: string;
  name_from_folder: boolean;
  rename_pattern?: string | null;
};

export type FolderNode = {
  id: string;
  name_pattern: string;
  is_footage_destination: boolean;
  children: FolderNode[];
  template_files: TemplateFile[];
  condition?: FolderCondition | null;
  role?: FolderRole | null;
};

export type PresetDestinations = {
  primary: string;
  secondaries: string[];
};

export type Preset = {
  schema_version: 1;
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  variables: PresetVariable[];
  root_folder_pattern: string;
  folder_tree: FolderNode[];
  file_rename_pattern: string;
  clip_number_padding: number;
  per_folder_rename_overrides: Record<string, string>;
  destinations: PresetDestinations;
  file_type_routing_overrides: Record<string, string>;
  preserve_xml_sidecars: boolean;
  rename_files_default: boolean;
  metadata_preset_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type PresetSummary = {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  updated_at: string;
};

export type AppSettings = {
  global_parameters: PresetVariable[];
  ingest_defaults: {
    auto_scan_sources: boolean;
    rename_files: boolean;
    delete_sidecars: boolean;
    destination_mode: "create_new" | "existing_root";
    open_folder_when_done: boolean;
  };
  report_defaults: {
    include_thumbnails: boolean;
    write_html_report: boolean;
    open_report_when_done: boolean;
    notes_template: string;
  };
  camera_watcher: {
    auto_detect_cards: boolean;
    prompt_on_card_detected: boolean;
    tray_mode: boolean;
  };
  file_selector: {
    default_view: "list" | "thumbs";
    thumbnail_size: number;
    group_by_date: boolean;
  };
  operator_name: string;
};

export type TokenContext = {
  preset_name?: string | null;
  variable_values?: Record<string, string>;
  date?: string | null;
  camera?: string | null;
  clip_number?: number | null;
  clip_number_padding?: number | null;
  original_name?: string | null;
  capture_date?: string | null;
  extension?: string | null;
  folder_name?: string | null;
};
