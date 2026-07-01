import type { FolderNode, Preset, PresetVariable } from "./types";

// The team's video naming SOP, encoded as data so the Naming Assistant keeps everyone
// aligned automatically. Ministry codes and campuses come from Chase's naming
// spreadsheet; the deliverable templates below are every distinct row of the "Video
// Naming System" tabs (Capture = date of first capture, Delivered = date of first
// premiere). Each becomes its own folder preset saved to the Documents library.
//
// Pattern tokens: {year}-{month}-{day} for the date, {campus} for the campus
// abbreviation (KLR/HLT/MCK), {series_name} for a series, {first_name}{last_name}
// for stories. A blank optional token collapses its separator automatically.

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

// Campus abbreviations used inside names (KLR home, HLT Haslet, MCK McKinney).
export const CAMPUS_ABBREVIATIONS = ["KLR", "HLT", "MCK"];

// Video signifiers from the SOP (appended to a delivered video name when needed).
export const VIDEO_SIGNIFIERS = [
  "Impact",
  "Recap",
  "Promo",
  "Story",
  "BaptismStory",
  "Opener",
  "RollIn",
  "SpeakerIntro",
  "TitlePackage",
  "SmallGroup",
  "Countdown",
  "MusicVideo",
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
  group: "Video Capture" | "Delivered Video";
  hint: string;
  presetId: string;
  presetName: string;
  rootPattern: string;
  // Optional year-aware pre-folder created before the project folder (e.g. "{year}/Broll").
  subPath?: string;
  fields: NamingField[];
};

// Reusable field builders for the variable parts of a name.
const campusField = (): NamingField => ({
  id: "campus",
  label: "Campus",
  type: "dropdown",
  required: true,
  options: CAMPUS_ABBREVIATIONS,
});
const seriesField = (): NamingField => ({
  id: "series_name",
  label: "Series name",
  type: "short_text",
  required: true,
  placeholder: "SeriesName",
});
const firstField = (): NamingField => ({ id: "first_name", label: "First name", type: "short_text", required: true });
const lastField = (): NamingField => ({ id: "last_name", label: "Last name", type: "short_text", required: true });

const DATE = "{year}-{month}-{day}";

// [idSuffix, display label, name part after the date, fields]
type Row = [string, string, string, NamingField[]];

// Tab 3 — EVENT capture folders (date = first capture).
const CAPTURE_ROWS: Row[] = [
  ["weekend", "Weekends", "_Weekend_{campus}", [campusField()]],
  ["elevate", "Elevate", "_Elevate_{campus}", [campusField()]],
  ["mya", "MYA", "_MYA", []],
  ["gt_step1", "Growth Track — Step 1", "_Step1_{campus}", [campusField()]],
  ["gt_step2", "Growth Track — Step 2", "_Step2_{campus}", [campusField()]],
  ["gt_step3", "Growth Track — Step 3", "_Step3_{campus}", [campusField()]],
  ["small_groups", "Small Groups", "_SmallGroups", []],
  ["milestone_college", "Milestone College", "_MilestoneCollege", []],
  ["prepare", "Prepare", "_Prepare", []],
  ["leaders_gathering", "Leaders Gathering", "_LeadersGathering", []],
  ["hs_bots", "High School BOTS", "_HighSchoolBOTS", []],
  ["ms_bots", "Middle School BOTS", "_MiddleSchoolBOTS", []],
  ["mc_preview_day", "MC Preview Day", "_MCPreviewDay", []],
  ["easter", "Easter", "_Easter", []],
  ["super_series_wk1", "Super Series — Week 1", "_SuperSeriesWk1", []],
  ["super_series_wk2", "Super Series — Week 2", "_SuperSeriesWk2", []],
  ["super_series_wk3", "Super Series — Week 3", "_SuperSeriesWk3", []],
  ["serve_day", "Serve Day", "_ServeDay", []],
  ["mc_grad_dinner", "MC Graduation Dinner", "_MCGraduationDinner", []],
  ["single_moms_dinner", "Single Mom's Dinner", "_SingleMomsDinner", []],
  ["ms_camp", "Middle School Summer Camp", "_MiddleSchoolCamp", []],
  ["summer_splash", "Summer Splash", "_SummerSplash", []],
  ["forty5_blast", "Forty5 Summer Blast", "_Forty5SummerBlast", []],
  ["vbs", "VBS", "_VBS", []],
  ["hs_camp", "High School Summer Camp", "_HighSchoolCamp", []],
  ["mya_conference", "MYA Conference", "_MYAConference", []],
  ["freedom_weekend", "Freedom Weekend", "_FreedomWeekend", []],
  ["mc_welcome_week", "MC Welcome Week", "_MCWelcomeWeek", []],
  ["fairy_tale_ball", "Fairy Tale Ball", "_FairyTaleBall", []],
  ["mens_night", "Men's Night", "_MensNight", []],
  ["thanksgiving_boxes", "Thanksgiving Box Outreach", "_ThanksgivingBoxes", []],
  ["veterans_celebration", "Veteran's Celebration", "_VeteransCelebration", []],
  ["mc_fall_trip", "MC Fall Trip", "_MCFallTrip", []],
  ["christmas_wonder", "Christmas Wonder", "_ChristmasWonder", []],
  ["joy", "JOY", "_JOY", []],
  ["christmas", "Christmas", "_Christmas", []],
];

// Tab 4 — DELIVERED VIDEO folders (date = first premiere).
const DELIVERED_ROWS: Row[] = [
  ["baptism_individual", "Individual Baptism Story", "_{first_name}{last_name}_Story", [firstField(), lastField()]],
  ["baptism_couple", "Couple / Family Baptism Story", "_{last_name}_Story", [lastField()]],
  ["onl", "Online Campus Hosting (ONL)", "_ONL", []],
  ["vas", "Video Announcements (VAs)", "_VAs", []],
  ["mlk_opener", "MLK Weekend Video", "_MLK_Opener", []],
  ["noon_prayer", "Noon Prayer", "_NoonPrayer", []],
  ["noon_prayer_worship", "Noon Prayer Worship", "_NoonPrayerWorship", []],
  ["campaign_small_group", "Campaign Small Group Videos", "_{series_name}_SmallGroup", [seriesField()]],
  ["spring_series_kids", "Spring Series Kids Video", "_{series_name}Kids_Recap", [seriesField()]],
  ["milestone_college_promo", "Milestone College Promo", "_MilestoneCollege_Promo", []],
  ["hs_bots_recap", "High School BOTS Recap", "_HighSchoolBOTS_Recap", []],
  ["ms_bots_recap", "Middle School BOTS Recap", "_MiddleSchoolBOTS_Recap", []],
  ["super_series_promo", "Super Series Promo", "_SuperSeries_Promo", []],
  ["super_series_title", "Super Series Title Package", "_SuperSeries_TitlePackage", []],
  ["easter_promo", "Easter Promo", "_Easter_Promo", []],
  ["christ_haven_impact", "Christ's Haven Impact", "_ChristHaven_Impact", []],
  ["lets_talk_family_promo", "Let's Talk Family Series Promo", "_LetsTalkFamily_Promo", []],
  ["serve_day_impact", "Serve Day Impact", "_ServeDay_Impact", []],
  ["summer_camp_promo", "Summer Camp Promo", "_SummerCamp_Promo", []],
  ["summer_splash_promo", "Summer Splash Promo", "_SummerSplash_Promo", []],
  ["summer_splash_rollin", "Summer Splash Roll-In", "_SummerSplash_RollIn", []],
  ["summer_splash_speaker", "Summer Splash Speaker Intro", "_SummerSplash_SpeakerIntro", []],
  ["memorial_day_opener", "Memorial Day Opener", "_MemorialDay_Opener", []],
  ["memorial_day_story", "Memorial Day Story", "_MemorialDay_Story", []],
  ["legacy_spring_vision", "Legacy Spring Vision Video", "_LegacySpringVision", []],
  ["series_promo", "Series Promo", "_{series_name}_Promo", [seriesField()]],
  ["ms_camp_recap", "Middle School Camp Recap", "_MSCamp_Recap", []],
  ["vbs_forty5_recap", "VBS / Forty5 Recap", "_VBSForty5_Recap", []],
  ["hs_camp_ngsl_recap", "High School Camp / NGSL Recap", "_HSCampNGSL_Recap", []],
  ["small_groups_promo", "Small Groups Promo", "_SmallGroups_Promo", []],
  ["school_outreach_impact", "Back to School / Teacher Outreach Impact", "_SchoolOutreach_Impact", []],
  ["super_series_impact", "Next Gen / Super Series Impact", "_SuperSeries_Impact", []],
  ["fairytale_ball_impact", "Fairytale Ball Impact", "_FairytaleBall_Impact", []],
  ["make_a_difference_promo", "Make a Difference Series Promo", "_MakeADifference_Promo", []],
  ["veterans_day_impact", "Veteran's Day Impact", "_VeteransDay_Impact", []],
  ["joy_promo", "JOY Promo", "_JOY_Promo", []],
  ["bots_promo", "BOTS Promo", "_BOTS_Promo", []],
  ["christmas_promo", "Christmas Promo", "_Christmas_Promo", []],
  ["thanksgiving_boxes_impact", "Thanksgiving Boxes Outreach Impact", "_ThanksgivingBoxes_Impact", []],
  ["legacy_fall_vision", "Legacy Fall Vision Video", "_LegacyFallVision", []],
  ["christmas_wonder_promo", "Christmas Wonder Impact", "_ChristmasWonder_Promo", []],
  ["legacy_impact", "Legacy Impact", "_Legacy_Impact", []],
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
export const NAMING_CATALOG_VERSION = 3;

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
    description: `Auto-named per the SOP: ${deliverable.hint}`,
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
