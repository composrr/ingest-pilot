import type { FolderNode, Preset, PresetVariable } from "./types";

// The team's naming SOP, encoded as data so the Naming Assistant keeps everyone
// aligned automatically. Ministry codes, campuses, and the event catalog come from
// Chase's naming spreadsheet; the video deliverable templates and folder structure
// come from the SOP Google Doc's "Folder Naming Conventions" section.
//
// Video naming (what these templates build): YYYY-MM-DD_VideoName_Signifier.
// Campus is NOT part of a video name — for a multi-campus capture it becomes a
// subfolder under 02_Footage; for a single campus it's just tagged in iconik.

export const NAMING_MINISTRIES: { code: string; label: string }[] = [
  { code: "CEN", label: "Central" },
  { code: "WKD", label: "Weekends" },
  { code: "YTH", label: "Youth" },
  { code: "MYA", label: "Young Adults" },
  { code: "MC", label: "Milestone College" },
  { code: "MK", label: "Milestone Kids" },
  { code: "MIS", label: "Missions" },
  { code: "SMG", label: "Small Groups" },
  { code: "BAP", label: "Pastoral Care (Baptism)" },
  { code: "LTW", label: "Pastor Jeff (Leaders)" },
];

export const NAMING_CAMPUSES = ["Keller", "Haslet", "McKinney", "Online"];

// Campus abbreviations used for multi-campus footage subfolders (Keller is home, no
// abbreviation). Mirrors the HLT / MCK usage in the naming sheet.
export const CAMPUS_ABBREVIATIONS: Record<string, string> = {
  Keller: "KLR",
  Haslet: "HLT",
  McKinney: "MCK",
  Online: "ONL",
};

// Video signifiers straight from the SOP doc (order preserved). Note: no "Recap".
export const VIDEO_SIGNIFIERS = [
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

// The event catalog from the naming sheet: event label -> file-name token + ministry
// code. Deduplicated across the calendar (recurring events listed once). Drives the
// Event dropdown in the capture/edited templates so every event is one click away.
export type NamingEvent = { label: string; token: string; code: string };

export const NAMING_EVENTS: NamingEvent[] = [
  { label: "Prepare", token: "Prepare", code: "CEN" },
  { label: "Easter", token: "Easter", code: "CEN" },
  { label: "Mother's Day", token: "MothersDay", code: "CEN" },
  { label: "Father's Day", token: "FathersDay", code: "CEN" },
  { label: "Summer Splash", token: "SummerSplash", code: "CEN" },
  { label: "Summer Treats Kick-Off", token: "SummerTreats", code: "CEN" },
  { label: "Serve Team Vision Night", token: "ServeTeamVisionNight", code: "CEN" },
  { label: "Staff Gathering", token: "StaffGathering", code: "CEN" },
  { label: "Men's Night", token: "MensNight", code: "CEN" },
  { label: "ARC", token: "ARC", code: "CEN" },
  { label: "JOY", token: "JOY", code: "CEN" },
  { label: "Legacy", token: "Legacy", code: "CEN" },
  { label: "CAM", token: "CAM", code: "CEN" },
  { label: "CCC", token: "CCC", code: "CEN" },
  { label: "Miracles Book", token: "MiraclesBook", code: "CEN" },
  { label: "Unshakable Resource", token: "UnshakableResource", code: "CEN" },
  { label: "Milestone Resources", token: "MilestoneResources", code: "CEN" },
  { label: "Leaders Gathering", token: "LeadersGathering", code: "LTW" },
  { label: "Baptism Weekend", token: "BaptismWeekend", code: "BAP" },
  { label: "Young Adults (MYA)", token: "YoungAdults", code: "MYA" },
  { label: "BOTS (High School)", token: "HSBOTS", code: "YTH" },
  { label: "BOTS (Middle School)", token: "MSBOTS", code: "YTH" },
  { label: "Super Series (Spring)", token: "SpringSuperSeries", code: "YTH" },
  { label: "Super Series (Fall)", token: "FallSuperSeries", code: "YTH" },
  { label: "NGSL Kickoff", token: "NGSL", code: "YTH" },
  { label: "Senior Recognition", token: "SeniorRecognition", code: "YTH" },
  { label: "Middle School Camp", token: "MSC", code: "YTH" },
  { label: "High School Camp", token: "HSC", code: "YTH" },
  { label: "NextGen Weekend", token: "NextGenWeekend", code: "YTH" },
  { label: "Fall Retreat", token: "FallRetreat", code: "YTH" },
  { label: "LADC", token: "LADC", code: "MC" },
  { label: "MC Dinner", token: "CollegeDinner", code: "MC" },
  { label: "MC Welcome Week", token: "WelcomeWeek", code: "MC" },
  { label: "MC Headshots", token: "MCHeadshots", code: "MC" },
  { label: "MC Interest Meeting", token: "CollegeInterestMeeting", code: "MC" },
  { label: "MC Preview Day", token: "PreviewDay", code: "MC" },
  { label: "Baby Dedications", token: "BabyDedications", code: "MK" },
  { label: "Forty4 Camp", token: "Forty5Camp", code: "MK" },
  { label: "VBS", token: "VBS", code: "MK" },
  { label: "Fifty6 Camp (Session 2)", token: "Fifty6Camp2", code: "MK" },
  { label: "2nd Saturday Serve", token: "2ndSatServe", code: "MIS" },
  { label: "Evergreen", token: "Evergreen", code: "MIS" },
  { label: "Refugee Food Distribution", token: "RefugeeDistribution", code: "MIS" },
  { label: "Serve Day", token: "ServeDay", code: "MIS" },
  { label: "Single Mother's Dinner", token: "SingleMomsDinner", code: "MIS" },
  { label: "MYA Guatemala Trip", token: "MYAGuat", code: "MIS" },
  { label: "Guatemala Mission Trip", token: "Guat", code: "MIS" },
  { label: "FTW Refugee Mission Trip", token: "RefugeeMissionTrip", code: "MIS" },
  { label: "Back To School Party", token: "BackToSchoolParty", code: "MIS" },
  { label: "Shoe Giveaway Drive", token: "ShoeGiveawayDrive", code: "MIS" },
  { label: "Teacher Appreciation Weekend", token: "TeacherAppreciation", code: "MIS" },
  { label: "Fairy Tale Ball", token: "FairyTaleBall", code: "MIS" },
  { label: "Missions Weekend", token: "MissionsWeekend", code: "MIS" },
  { label: "Veterans Celebration", token: "VetCelebration", code: "MIS" },
  { label: "Christmas Wonder", token: "ChristmasWonder", code: "MIS" },
  { label: "Christmas Teacher Gifts", token: "ChristmasTeacherGifts", code: "MIS" },
  { label: "Snow Outreach", token: "SnowOutreach", code: "MIS" },
  { label: "Freedom Weekend", token: "FreedomWeekend", code: "SMG" },
];

const EVENT_TOKENS = NAMING_EVENTS.map((event) => event.token);

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
  group: "Delivered Video" | "Video Capture" | "Story" | "Photo";
  hint: string;
  presetId: string;
  presetName: string;
  rootPattern: string;
  // Optional year-aware pre-folder created before the project folder (e.g. "{year}/Broll").
  subPath?: string;
  fields: NamingField[];
};

// Standard video project tree from the SOP doc: project files, footage (with an
// optional per-campus subfolder for multi-campus captures), audio, and exports
// split into Review / Masters.
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

const DATE = "{year}-{month}-{day}";

const EVENT_FIELD: NamingField = {
  id: "event_name",
  label: "Event",
  type: "dropdown",
  required: true,
  options: EVENT_TOKENS,
  placeholder: "Choose event",
};

const CAMPUS_FIELD: NamingField = {
  id: "campus",
  label: "Campus (multi-campus only)",
  type: "dropdown",
  required: false,
  options: NAMING_CAMPUSES,
};

const SIGNIFIER_FIELD: NamingField = {
  id: "signifier",
  label: "Signifier",
  type: "dropdown",
  required: false,
  options: VIDEO_SIGNIFIERS,
};

export const NAMING_DELIVERABLES: NamingDeliverable[] = [
  {
    id: "video_capture",
    label: "Event / B-Roll Capture",
    group: "Video Capture",
    hint: "YYYY-MM-DD_EventName  (date = first capture)",
    presetId: "naming_video_capture",
    presetName: "Capture — Event / B-Roll",
    rootPattern: `${DATE}_{event_name}`,
    subPath: "{year}/Broll",
    fields: [EVENT_FIELD, CAMPUS_FIELD],
  },
  {
    id: "impact_video",
    label: "Impact Video",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_EventName_Impact  (date = premiere)",
    presetId: "naming_impact",
    presetName: "Edited — Impact Video",
    rootPattern: `${DATE}_{event_name}_Impact`,
    fields: [EVENT_FIELD],
  },
  {
    id: "promo_video",
    label: "Promo Video",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_VideoName_Promo",
    presetId: "naming_promo",
    presetName: "Edited — Promo Video",
    rootPattern: `${DATE}_{video_name}_Promo`,
    fields: [{ id: "video_name", label: "Video name", type: "short_text", required: true, placeholder: "SummerSplash" }],
  },
  {
    id: "edited_video",
    label: "Edited Video (choose signifier)",
    group: "Delivered Video",
    hint: "YYYY-MM-DD_VideoName[_Signifier]",
    presetId: "naming_edited",
    presetName: "Edited — Video",
    rootPattern: `${DATE}_{video_name}_{signifier}`,
    fields: [
      { id: "video_name", label: "Video name", type: "short_text", required: true, placeholder: "MiddleSchoolCamp" },
      SIGNIFIER_FIELD,
    ],
  },
  {
    id: "individual_story",
    label: "Individual Story",
    group: "Story",
    hint: "YYYY-MM-DD_FirstLast_Story",
    presetId: "naming_individual_story",
    presetName: "Story — Individual",
    rootPattern: `${DATE}_{first_name}{last_name}_Story`,
    fields: [
      { id: "first_name", label: "First name", type: "short_text", required: true },
      { id: "last_name", label: "Last name", type: "short_text", required: true },
    ],
  },
  {
    id: "couple_story",
    label: "Couple / Family Story",
    group: "Story",
    hint: "YYYY-MM-DD_LastName_Story",
    presetId: "naming_couple_story",
    presetName: "Story — Couple / Family",
    rootPattern: `${DATE}_{last_name}_Story`,
    fields: [{ id: "last_name", label: "Last name", type: "short_text", required: true }],
  },
  {
    id: "individual_baptism_story",
    label: "Individual Baptism Story",
    group: "Story",
    hint: "YYYY-MM-DD_FirstLast_BaptismStory",
    presetId: "naming_individual_baptism",
    presetName: "Story — Individual Baptism",
    rootPattern: `${DATE}_{first_name}{last_name}_BaptismStory`,
    fields: [
      { id: "first_name", label: "First name", type: "short_text", required: true },
      { id: "last_name", label: "Last name", type: "short_text", required: true },
    ],
  },
  {
    id: "couple_baptism_story",
    label: "Couple / Family Baptism Story",
    group: "Story",
    hint: "YYYY-MM-DD_LastName_BaptismStory",
    presetId: "naming_couple_baptism",
    presetName: "Story — Couple / Family Baptism",
    rootPattern: `${DATE}_{last_name}_BaptismStory`,
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
];

// The full, editable naming catalog — persisted as one JSON file in the Documents
// library so the team can adjust it and sync across machines.
export type NamingMinistry = { code: string; label: string };

export type NamingCatalog = {
  schema_version: number;
  ministries: NamingMinistry[];
  campuses: string[];
  signifiers: string[];
  events: NamingEvent[];
  deliverables: NamingDeliverable[];
};

// Bump when the shipped defaults change so an older persisted catalog is refreshed.
export const NAMING_CATALOG_VERSION = 2;

export function defaultNamingCatalog(): NamingCatalog {
  return {
    schema_version: NAMING_CATALOG_VERSION,
    ministries: NAMING_MINISTRIES.map((ministry) => ({ ...ministry })),
    campuses: [...NAMING_CAMPUSES],
    signifiers: [...VIDEO_SIGNIFIERS],
    events: NAMING_EVENTS.map((event) => ({ ...event })),
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
    events: persisted.events?.length ? persisted.events : base.events,
    deliverables: persisted.deliverables?.length ? persisted.deliverables : base.deliverables,
  };
}

export function deliverableById(id: string): NamingDeliverable | undefined {
  return NAMING_DELIVERABLES.find((deliverable) => deliverable.id === id);
}

// Builds a folder Preset from a deliverable: its SOP name pattern + year-aware
// pre-folder, its fields as variables, and the standard video subfolder tree.
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
    destinations: { primary: "", secondaries: [], sub_path_pattern: deliverable.subPath ?? "" },
    file_type_routing_overrides: { ".wav": "folder_audio", ".mp3": "folder_audio" },
    preserve_xml_sidecars: true,
    rename_files_default: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// One folder Preset per shipped deliverable — used to seed ready-made preset files
// into the Documents library so the team can ingest immediately.
export function createNamingPresets(nowIso: string): Preset[] {
  return NAMING_DELIVERABLES.map((deliverable) => buildNamingPreset(deliverable, nowIso));
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
