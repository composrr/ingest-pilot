export type VariableType = "short_text" | "long_text" | "dropdown" | "boolean" | "date";

// Metadata presets (Lightroom-style): reusable shoot-level metadata schemas.
export type MetadataFieldType =
  | "text"
  | "long_text"
  | "dropdown"
  | "multi_select"
  | "boolean"
  | "date"
  // Who shot the video: options come from the shared Shooters roster (Settings) and it
  // defaults to this machine's operator.
  | "shooter";

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
  // Optional metadata preset for clips routed into this folder — lets different
  // campus folders under one root carry their own metadata in a single import.
  metadata_preset_id?: string | null;
};

export type PresetDestinations = {
  primary: string;
  secondaries: string[];
  // Optional tokenized sub-path inserted between the chosen destination and the
  // project root folder, resolved per ingest (e.g. "{year}/Broll"). Lets a preset
  // point at a stable parent (…/Videos) and descend into/create the current year's
  // structure automatically. Optional so existing presets/literals stay valid.
  sub_path_pattern?: string;
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
  // Preset-chosen metadata field values (field id -> value) pre-filled for imports
  // made with this preset, so it carries its own tags without editing the schema.
  metadata_values?: Record<string, string>;
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
    date_format: string;
  };
  report_defaults: {
    include_thumbnails: boolean;
    write_html_report: boolean;
    open_report_when_done: boolean;
    notes_template: string;
    output_location: ReportOutputLocation;
    // Longest edge (px) of generated report thumbnails.
    thumbnail_max_edge: number;
    // JPEG quality (1-100) for generated report thumbnails.
    thumbnail_jpeg_quality: number;
  };
  camera_watcher: {
    auto_detect_cards: boolean;
    // Raise the window and jump to Ingest with the card pre-selected on insert.
    pop_open_on_card: boolean;
    // Keep running in the background (close to tray) instead of quitting.
    tray_mode: boolean;
    // Start the app at login so the watcher is running before a card is inserted.
    launch_at_login: boolean;
    // How aggressively to surface the window on card insert.
    pop_open_mode: PopOpenMode;
  };
  file_selector: {
    default_view: "list" | "thumbs";
    thumbnail_size: number;
    group_by_date: boolean;
  };
  operator_name: string;
  custom_file_kinds: Record<string, string>;
  // Roster of shooters offered by a "Shooter" metadata field; the field defaults to
  // operator_name (this machine's user). Staff show by default; volunteers/contractors
  // are revealed on request so a big event can be pre-loaded without cluttering.
  shooters: Shooter[];
  iconik: IconikSettings;
  // Completion-sound behavior.
  sound: { enabled: boolean; volume: number };
  // Data-integrity guardrails enforced on this machine.
  safety: SafetySettings;
  // Friendly names for card readers / volumes, keyed by volume root path.
  drive_nicknames: Record<string, string>;
  // Show advanced settings sections in the UI.
  show_advanced: boolean;
};

export type PopOpenMode = "always" | "if_frontmost" | "notify";

export type ReportOutputLocation = {
  mode: "root" | "subfolder" | "custom";
  subfolder: string;
  custom_path: string;
  move_mhl: boolean;
};

export type SafetySettings = {
  never_delete_source: boolean;
  low_space_stop_percent: number;
  min_verified_copies: number;
  confirm_destructive: boolean;
  always_write_offload_proof: boolean;
  safe_mode: boolean;
};

export type ShooterGroup = "staff" | "volunteer" | "contractor";

export type Shooter = {
  name: string;
  group: ShooterGroup;
};

export type IconikSettings = {
  base_url: string;
  app_id: string;
  auth_token: string;
  view_id: string;
  view_name: string;
  auto_push: boolean;
};

export type TokenContext = {
  preset_name?: string | null;
  variable_values?: Record<string, string>;
  date?: string | null;
  date_format?: string | null;
  camera?: string | null;
  clip_number?: number | null;
  clip_number_padding?: number | null;
  original_name?: string | null;
  capture_date?: string | null;
  extension?: string | null;
  folder_name?: string | null;
};
