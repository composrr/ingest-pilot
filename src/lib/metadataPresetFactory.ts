import type { IconikField, IconikView } from "./tauri";
import type { MetadataField, MetadataFieldType, MetadataPreset } from "./types";

// Seeds a starter metadata preset that mirrors the team's iconik metadata view
// (General / People-Story / Admin). Every field id is the CSV column header, chosen
// to line up with the iconik field names for a clean bulk import. Users can edit the
// categories, fields, and options in the Metadata editor.
function field(
  id: string,
  label: string,
  fieldType: MetadataField["field_type"],
  options: string[] = [],
): MetadataField {
  return { id, label, field_type: fieldType, options, default: null };
}

// Maps an iconik field type to the app's field type. iconik uses names like
// "string" / "text" / "drop_down" / "boolean" / "date"; a field marked `multi` (or a
// dropdown that allows several values) becomes a multi-select.
function iconikFieldTypeToApp(field: IconikField): MetadataFieldType {
  const type = (field.field_type || "").toLowerCase();
  const isChoice = type.includes("drop") || type.includes("select") || field.options.length > 0;
  if (isChoice) {
    return field.multi ? "multi_select" : "dropdown";
  }
  if (field.multi) {
    return "multi_select";
  }
  if (type === "text" || type === "string_long" || type === "long_text") {
    return "long_text";
  }
  if (type === "boolean" || type === "bool") {
    return "boolean";
  }
  if (type.startsWith("date")) {
    return "date";
  }
  return "text";
}

// Builds a metadata preset that mirrors an iconik view exactly: every field id is the
// iconik field name (so pushes map 1:1 with no guessing), the label is iconik's label,
// and dropdowns carry iconik's controlled vocabulary. Re-importing the same view keeps
// a stable id so it updates in place rather than duplicating.
export function metadataPresetFromIconikView(
  view: IconikView,
  fields: IconikField[],
  nowIso: string,
): MetadataPreset {
  return {
    schema_version: 1,
    id: `iconik-view-${view.id}`,
    name: `iconik — ${view.name}`,
    description: `Imported from the iconik metadata view "${view.name}". Fields and options mirror iconik.`,
    created_at: nowIso,
    updated_at: nowIso,
    categories: [
      {
        id: "iconik",
        name: view.name || "iconik",
        fields: fields.map((iconikField) => ({
          id: iconikField.name,
          label: iconikField.label || iconikField.name,
          field_type: iconikFieldTypeToApp(iconikField),
          options: iconikField.options ?? [],
          default: null,
        })),
      },
    ],
  };
}

export function createDefaultMetadataPreset(nowIso: string): MetadataPreset {
  return {
    schema_version: 1,
    id: "iconik-default",
    name: "iconik — Default",
    description: "Shoot-level metadata mirroring the iconik metadata view.",
    created_at: nowIso,
    updated_at: nowIso,
    categories: [
      {
        id: "general",
        name: "General",
        fields: [
          field("Campus", "Campus", "dropdown", ["Keller", "Haslet", "McKinney", "Online"]),
          field("Ministry", "Ministry", "dropdown", [
            "Central",
            "Growth Track",
            "Milestone College",
            "Milestone Kids",
            "Missions",
            "Small Groups",
            "Weekends",
            "Young Adults",
            "Youth",
          ]),
          field("Location", "Location", "text"),
          field("VideoType", "Video Type", "dropdown", ["ARoll", "BRoll", "Interview", "Event", "Promo"]),
          field("ContentType", "Content Type", "dropdown", ["Recap", "Impact", "Promo", "Story", "Title Package"]),
          field("ShotType", "Shot Type", "dropdown", ["Wide", "Medium", "Close-Up", "Detail", "Establishing"]),
          field("Framing", "Framing", "dropdown", ["Static", "Handheld", "Gimbal", "Drone", "Slider"]),
          field("Keywords", "Keywords", "multi_select", [
            "baptism",
            "worship",
            "testimony",
            "kids",
            "outreach",
            "students",
            "prayer",
          ]),
          field("Notes", "Notes", "long_text"),
        ],
      },
      {
        id: "people-story",
        name: "People / Story",
        fields: [
          field("Shooter", "Shooter", "shooter"),
          field("Talent", "Talent", "text"),
          field("SubjectType", "Subject Type", "dropdown", ["Individual", "Couple", "Family", "Group", "Crowd"]),
          field("Diversity", "Diversity", "boolean"),
        ],
      },
      {
        id: "admin",
        name: "Admin",
        fields: [field("Blocked", "Blocked", "boolean"), field("ReleaseOnFile", "Release On File", "boolean")],
      },
    ],
  };
}
