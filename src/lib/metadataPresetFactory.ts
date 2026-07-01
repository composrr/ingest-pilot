import type { MetadataField, MetadataPreset } from "./types";

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
