import type { FolderNode, Preset, PresetVariable } from "./types";

// The team's naming SOP, encoded as data so the Naming Assistant can keep everyone
// aligned automatically. Ministry codes, campuses, and video signifiers come straight
// from the naming spreadsheet; the deliverable templates come from the SOP's
// "Folder Naming Conventions" section. Each deliverable maps to a seeded preset whose
// root_folder_pattern builds the SOP-correct project folder name from its fields.

export const NAMING_MINISTRIES: { code: string; label: string }[] = [
  { code: "CEN", label: "Central" },
  { code: "GRT", label: "Growth Track" },
  { code: "MC", label: "Milestone College" },
  { code: "MK", label: "Milestone Kids" },
  { code: "MIS", label: "Missions" },
  { code: "SMG", label: "Small Groups" },
  { code: "WKD", label: "Weekends" },
  { code: "MYA", label: "Young Adults" },
  { code: "YTH", label: "Youth" },
];

export const NAMING_CAMPUSES = ["Keller", "Haslet", "McKinney", "Online"];

export const VIDEO_SIGNIFIERS = [
  "Recap",
  "Impact",
  "Promo",
  "Story",
  "BaptismStory",
  "Countdown",
  "RollIn",
  "TitlePackage",
  "SpeakerIntro",
  "Opener",
  "MusicVideo",
  "SmallGroup",
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
  group: "Delivered Video" | "Video Capture" | "Photo";
  hint: string;
  presetId: string;
  presetName: string;
  rootPattern: string;
  fields: NamingField[];
};

// Standard subfolder tree used by the seeded naming presets. The root NAME is what
// the SOP cares about; the structure below is a sensible default the user can edit.
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
    leaf("folder_exports", "06_Exports", "other"),
  ];
}

const DATE = "{year}-{month}-{day}";

export const NAMING_DELIVERABLES: NamingDeliverable[] = [
  {
    id: "individual_baptism_story",
    label: "Individual Baptism Story",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_FirstLast_Story",
    presetId: "naming_individual_baptism",
    presetName: "Delivered — Individual Baptism Story",
    rootPattern: `${DATE}_{first_name}{last_name}_Story`,
    fields: [
      { id: "first_name", label: "First name", type: "short_text", required: true },
      { id: "last_name", label: "Last name", type: "short_text", required: true },
    ],
  },
  {
    id: "couple_baptism_story",
    label: "Couple / Family Baptism Story",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_LastName_Story",
    presetId: "naming_couple_baptism",
    presetName: "Delivered — Couple/Family Baptism Story",
    rootPattern: `${DATE}_{last_name}_Story`,
    fields: [{ id: "last_name", label: "Last name", type: "short_text", required: true }],
  },
  {
    id: "online_campus_hosting",
    label: "Online Campus Hosting (ONL)",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_ONL",
    presetId: "naming_onl",
    presetName: "Delivered — Online Campus (ONL)",
    rootPattern: `${DATE}_ONL`,
    fields: [],
  },
  {
    id: "video_capture",
    label: "Event / B-Roll Capture",
    group: "Video Capture",
    hint: "YYYY-MM-DD_EventName[_Signifier]",
    presetId: "naming_video_capture",
    presetName: "Capture — Event / B-Roll",
    rootPattern: `${DATE}_{event_name}_{signifier}`,
    fields: [
      { id: "event_name", label: "Event name", type: "short_text", required: true, placeholder: "MiddleSchoolCamp" },
      { id: "signifier", label: "Signifier (optional)", type: "dropdown", required: false, options: VIDEO_SIGNIFIERS },
      { id: "campus", label: "Campus (optional)", type: "dropdown", required: false, options: NAMING_CAMPUSES },
    ],
  },
  {
    id: "photo_weekend",
    label: "Weekend (Photo)",
    group: "Photo",
    hint: "YYYY-MM-DD_Weekend_Campus",
    presetId: "naming_photo_weekend",
    presetName: "Photo — Weekend",
    rootPattern: `${DATE}_Weekend_{campus}`,
    fields: [{ id: "campus", label: "Campus", type: "dropdown", required: true, options: NAMING_CAMPUSES }],
  },
];

export function deliverableById(id: string): NamingDeliverable | undefined {
  return NAMING_DELIVERABLES.find((deliverable) => deliverable.id === id);
}

// Builds the seeded Preset for a deliverable: its SOP root-name pattern plus the
// fields as variables and a standard editable subfolder tree.
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
    description: `Auto-named per the SOP: ${deliverable.hint}`,
    icon: "folder-tree",
    color: "#9fd7c7",
    variables,
    root_folder_pattern: deliverable.rootPattern,
    folder_tree: standardVideoTree(),
    file_rename_pattern: "{camera}_{clip#}",
    clip_number_padding: 3,
    per_folder_rename_overrides: {},
    destinations: { primary: "", secondaries: [] },
    file_type_routing_overrides: { ".wav": "folder_audio", ".mp3": "folder_audio" },
    preserve_xml_sidecars: true,
    rename_files_default: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// Local preview of the SOP folder name (mirrors the Rust token resolver's separator
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
