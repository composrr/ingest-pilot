import type { FolderNode, Preset, PresetVariable } from "./types";

// A small, generic set of video naming templates encoded as data so the Naming
// Assistant can build consistent project names. These are intentionally neutral
// starters — a team adapts them (or adds their own) on the Naming tab, and every
// template is saved to the visible Documents library as its own file.
//
// Pattern tokens: {year}-{month}-{day} for the date, plus each template's own
// fields (e.g. {event_name}, {subject}, {name}). A blank optional token collapses
// its separator automatically.

// Ministries and campuses are org-specific concepts, so nothing is shipped by
// default; a team fills these in on the Naming tab if they use them.
export const NAMING_MINISTRIES: { code: string; label: string }[] = [];

export const NAMING_CAMPUSES: string[] = [];

// Optional short campus/location abbreviations a team can add for use in names.
export const CAMPUS_ABBREVIATIONS: string[] = [];

// Generic video signifiers a delivered-video name can carry.
export const VIDEO_SIGNIFIERS = [
  "Promo",
  "Recap",
  "Story",
  "Opener",
  "Countdown",
  "TitlePackage",
];

export type NamingField = {
  id: string;
  label: string;
  type: PresetVariable["type"];
  required: boolean;
  options?: string[];
  placeholder?: string;
};

export type NamingDeliverable = {
  id: string;
  label: string;
  // Free-form group name for accordion sections (e.g. "Video Capture", "Weekends",
  // "Home"). The shipped defaults use "Video Capture" / "Delivered Video".
  group: string;
  hint: string;
  presetId: string;
  presetName: string;
  rootPattern: string;
  // Optional year-aware pre-folder created before the project folder (e.g. "{year}/Broll").
  subPath?: string;
  fields: NamingField[];
};

// Reusable field builders for the variable parts of a name.
const shortField = (id: string, label: string, placeholder: string): NamingField => ({
  id,
  label,
  type: "short_text",
  required: true,
  placeholder,
});

const DATE = "{year}-{month}-{day}";

// [idSuffix, display label, name part after the date, fields]
type Row = [string, string, string, NamingField[]];

// Generic capture templates (date = first capture).
const CAPTURE_ROWS: Row[] = [
  ["event", "Event", "_Event_{event_name}", [shortField("event_name", "Event name", "EventName")]],
  ["interview", "Interview", "_Interview_{subject}", [shortField("subject", "Subject", "Subject")]],
];

// Generic delivered-video templates (date = first premiere).
const DELIVERED_ROWS: Row[] = [
  ["story", "Story", "_{name}_Story", [shortField("name", "Name", "Name")]],
];

function rowsToDeliverables(rows: Row[], group: NamingDeliverable["group"]): NamingDeliverable[] {
  return rows.map(([idSuffix, label, namePart, fields]) => {
    const rootPattern = `${DATE}${namePart}`;
    return {
      id: idSuffix,
      label,
      group,
      hint: rootPattern.replace("{year}-{month}-{day}", "YYYY-MM-DD"),
      presetId: `naming_${idSuffix}`,
      presetName: `${group === "Video Capture" ? "Capture" : "Delivered"} — ${label}`,
      rootPattern,
      fields,
    };
  });
}

export const NAMING_DELIVERABLES: NamingDeliverable[] = [
  ...rowsToDeliverables(CAPTURE_ROWS, "Video Capture"),
  ...rowsToDeliverables(DELIVERED_ROWS, "Delivered Video"),
];

// The full, editable naming catalog — persisted as one JSON file in the Documents
// library so the team can adjust it and sync across machines.
export type NamingMinistry = { code: string; label: string };

export type NamingCatalog = {
  schema_version: number;
  ministries: NamingMinistry[];
  campuses: string[];
  signifiers: string[];
  deliverables: NamingDeliverable[];
};

// Bump when the shipped defaults change so an older persisted catalog is refreshed.
// v4: replaced the org-specific starter set with a small generic one.
export const NAMING_CATALOG_VERSION = 4;

export function defaultNamingCatalog(): NamingCatalog {
  return {
    schema_version: NAMING_CATALOG_VERSION,
    ministries: NAMING_MINISTRIES.map((ministry) => ({ ...ministry })),
    campuses: [...NAMING_CAMPUSES],
    signifiers: [...VIDEO_SIGNIFIERS],
    deliverables: NAMING_DELIVERABLES.map((deliverable) => ({
      ...deliverable,
      fields: deliverable.fields.map((field) => ({ ...field, options: field.options ? [...field.options] : undefined })),
    })),
  };
}

// Merges a persisted catalog over the shipped defaults. If the persisted catalog is
// older than the shipped version (or missing), the shipped defaults win so the real
// SOP data replaces earlier placeholders; otherwise user edits are kept.
export function mergeNamingCatalog(persisted: Partial<NamingCatalog> | null | undefined): NamingCatalog {
  const base = defaultNamingCatalog();
  if (!persisted || (persisted.schema_version ?? 1) < NAMING_CATALOG_VERSION) {
    return base;
  }
  return {
    schema_version: persisted.schema_version ?? base.schema_version,
    ministries: persisted.ministries?.length ? persisted.ministries : base.ministries,
    campuses: persisted.campuses?.length ? persisted.campuses : base.campuses,
    signifiers: persisted.signifiers?.length ? persisted.signifiers : base.signifiers,
    deliverables: persisted.deliverables?.length ? persisted.deliverables : base.deliverables,
  };
}

export function deliverableById(id: string): NamingDeliverable | undefined {
  return NAMING_DELIVERABLES.find((deliverable) => deliverable.id === id);
}

// Standard video project tree: project files, footage (with an optional
// per-campus subfolder for multi-location captures), audio, and exports split
// into Review / Masters.
function standardVideoTree(): FolderNode[] {
  const leaf = (id: string, name: string, role: FolderNode["role"], footage = false): FolderNode => ({
    id,
    name_pattern: name,
    role,
    is_footage_destination: footage,
    children: [],
    template_files: [],
  });
  return [
    leaf("folder_project_files", "01_ProjectFiles", "documents"),
    {
      ...leaf("folder_footage", "02_Footage", "footage", true),
      children: [
        {
          ...leaf("folder_campus", "{campus}", "footage", true),
          condition: { type: "variable_has_value", variable_id: "campus" },
        },
      ],
    },
    leaf("folder_audio", "03_Audio", "audio"),
    {
      ...leaf("folder_exports", "06_Exports", "other"),
      children: [leaf("folder_review", "01_Review", "other"), leaf("folder_masters", "04_Masters", "other")],
    },
  ];
}

// Builds a folder Preset from a deliverable: its SOP name pattern + optional
// year-aware pre-folder, its fields as variables, and the standard video subfolder tree.
export function buildNamingPreset(deliverable: NamingDeliverable, nowIso: string): Preset {
  const variables: PresetVariable[] = deliverable.fields.map((field) => ({
    id: field.id,
    name: field.label,
    type: field.type,
    required: field.required,
    default: "",
    options: field.options ?? [],
  }));
  return {
    schema_version: 1,
    id: deliverable.presetId,
    name: deliverable.presetName,
    description: `Auto-named from the naming template: ${deliverable.hint}`,
    icon: "folder-tree",
    color: deliverable.group === "Video Capture" ? "#9fd7c7" : "#c9a7ff",
    variables,
    root_folder_pattern: deliverable.rootPattern,
    folder_tree: standardVideoTree(),
    file_rename_pattern: "{camera}_{clip#}",
    clip_number_padding: 3,
    per_folder_rename_overrides: {},
    destinations: { primary: "", secondaries: [], sub_path_pattern: deliverable.subPath ?? "" },
    file_type_routing_overrides: { ".wav": "folder_audio", ".mp3": "folder_audio" },
    preserve_xml_sidecars: true,
    rename_files_default: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// Local preview of the SOP name (mirrors the Rust token resolver's separator
// collapsing) so the Assistant can show the result live without a round-trip.
export function previewNamingResult(deliverable: NamingDeliverable, values: Record<string, string>): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const resolved = deliverable.rootPattern.replace(/\{([^}]+)\}/g, (_match, token: string) => {
    if (token === "year") return year;
    if (token === "month") return month;
    if (token === "day") return day;
    if (token === "date") return `${year}${month}${day}`;
    return values[token] ?? "";
  });
  return resolved.replace(/([_-])[_-]+/g, "$1").replace(/^[_\- ]+|[_\- ]+$/g, "");
}
