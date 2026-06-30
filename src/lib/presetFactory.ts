import type { Preset } from "./types";

export function createBlankPreset(): Preset {
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);

  return {
    schema_version: 1,
    id: `preset_${suffix}`,
    name: "Untitled Preset",
    description: "",
    icon: "folder-tree",
    color: "#c9a7ff",
    variables: [
      {
        id: "project_name",
        name: "Project Name",
        type: "short_text",
        required: true,
        default: "Project",
        options: [],
      },
    ],
    root_folder_pattern: "{date}_{project_name}",
    folder_tree: [
      {
        id: "folder_footage",
        name_pattern: "Footage",
        is_footage_destination: true,
        role: "footage",
        children: [],
        template_files: [],
      },
      {
        id: "folder_audio",
        name_pattern: "Audio",
        is_footage_destination: false,
        role: "audio",
        children: [],
        template_files: [],
      },
      {
        id: "folder_project",
        name_pattern: "Project Files",
        is_footage_destination: false,
        children: [],
        template_files: [],
      },
    ],
    file_rename_pattern: "{project_name}_{camera}_{clip#}",
    clip_number_padding: 3,
    per_folder_rename_overrides: {},
    destinations: {
      primary: "",
      secondaries: [],
    },
    file_type_routing_overrides: {},
    preserve_xml_sidecars: true,
    rename_files_default: true,
    target_bps: 0,
    created_at: now,
    updated_at: now,
  };
}

export function createStarterPreset(): Preset {
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);

  return {
    schema_version: 1,
    id: `preset_${suffix}`,
    name: "Baptism Story",
    description: "Starter preset for a story shoot ingest.",
    icon: "video-camera",
    color: "#c9a7ff",
    variables: [
      {
        id: "story_name",
        name: "Story Name",
        type: "short_text",
        required: true,
        default: "",
        options: [],
      },
      {
        id: "campus",
        name: "Campus",
        type: "dropdown",
        required: false,
        default: "",
        options: ["KLR", "FM", "TL", "SL"],
      },
    ],
    root_folder_pattern: "{date}_BaptismStory_{story_name}",
    folder_tree: [
      {
        id: "folder_footage",
        name_pattern: "Footage",
        is_footage_destination: true,
        role: "footage",
        children: [
          {
            id: "folder_campus",
            name_pattern: "{campus}",
            is_footage_destination: true,
            role: "footage",
            children: [],
            template_files: [],
            condition: {
              type: "variable_has_value",
              variable_id: "campus",
            },
          },
        ],
        template_files: [],
      },
      {
        id: "folder_audio",
        name_pattern: "Audio",
        is_footage_destination: false,
        role: "audio",
        children: [],
        template_files: [],
      },
      {
        id: "folder_premiere",
        name_pattern: "Premiere",
        is_footage_destination: false,
        children: [],
        template_files: [],
      },
    ],
    file_rename_pattern: "{folder_name}_{camera}_{clip#}",
    clip_number_padding: 3,
    per_folder_rename_overrides: {
      folder_audio: "AUDIO_{original_name}",
    },
    destinations: {
      primary: "",
      secondaries: [],
    },
    file_type_routing_overrides: {
      ".wav": "folder_audio",
      ".mp3": "folder_audio",
    },
    preserve_xml_sidecars: true,
    rename_files_default: true,
    target_bps: 0,
    created_at: now,
    updated_at: now,
  };
}

export function createShippedPresets(): Preset[] {
  return [
    createVideoTeamPreset(),
    createInterviewPreset(),
    createDronePreset(),
    createMusicProducerPreset(),
  ];
}

function createVideoTeamPreset(): Preset {
  const now = new Date().toISOString();
  return {
    ...createBlankPreset(),
    id: `shipped_video_team_${crypto.randomUUID().slice(0, 8)}`,
    name: "Video Team Standard",
    description: "General production structure for footage, audio, projects, graphics, docs, exports, and reports.",
    color: "#9fd7c7",
    variables: [
      { id: "project_name", name: "Project Name", type: "short_text", required: true, default: "Project", options: [] },
      { id: "shoot_type", name: "Shoot Type", type: "dropdown", required: false, default: "", options: ["Interview", "Broll", "Event", "Story"] },
    ],
    root_folder_pattern: "{date}_{project_name}",
    folder_tree: [
      folder("folder_project_files", "01_ProjectFiles", "documents", false, [
        folder("folder_after_effects", "AfterEffects", null),
        folder("folder_premiere", "Premiere", null),
        folder("folder_resolve", "Resolve", null),
      ]),
      folder("folder_footage", "02_Footage", "footage", true),
      folder("folder_audio", "03_Audio", "audio", false, [
        folder("folder_audio_vo", "01_VO", "audio"),
        folder("folder_audio_music", "02_Music", "audio"),
        folder("folder_audio_sfx", "03_SFX", "audio"),
      ]),
      folder("folder_assets", "04_Assets", "photos", false, [
        folder("folder_graphics", "01_Graphics", "photos"),
        folder("folder_photos", "02_Photos", "photos"),
      ]),
      folder("folder_docs", "05_ProductionDocs", "documents"),
      folder("folder_exports", "06_Exports", "other", false, [
        folder("folder_review", "01_Review", "other"),
        folder("folder_final", "02_Final", "other"),
      ]),
    ],
    file_rename_pattern: "{project_name}_{camera}_{clip#}",
    file_type_routing_overrides: { ".wav": "folder_audio", ".mp3": "folder_audio", ".jpg": "folder_photos", ".png": "folder_graphics", ".pdf": "folder_docs" },
    created_at: now,
    updated_at: now,
  };
}

function createInterviewPreset(): Preset {
  const now = new Date().toISOString();
  return {
    ...createBlankPreset(),
    id: `shipped_interview_${crypto.randomUUID().slice(0, 8)}`,
    name: "Interview Shoot",
    description: "Simple interview preset with A-cam, B-cam, audio, transcripts, and exports.",
    color: "#c9a7ff",
    variables: [
      { id: "subject", name: "Subject", type: "short_text", required: true, default: "Subject", options: [] },
      { id: "project_name", name: "Project Name", type: "short_text", required: true, default: "Interview", options: [] },
    ],
    root_folder_pattern: "{date}_{project_name}_{subject}",
    folder_tree: [
      folder("folder_footage", "Footage", "footage", true, [
        folder("folder_a_cam", "A-Cam", "footage", true),
        folder("folder_b_cam", "B-Cam", "footage", true),
      ]),
      folder("folder_audio", "Audio", "audio"),
      folder("folder_transcripts", "Transcripts", "documents"),
      folder("folder_project", "Project Files", "documents"),
      folder("folder_exports", "Exports", "other"),
    ],
    file_rename_pattern: "{subject}_{camera}_{clip#}",
    file_type_routing_overrides: { ".wav": "folder_audio", ".mp3": "folder_audio", ".txt": "folder_transcripts", ".docx": "folder_transcripts", ".pdf": "folder_transcripts" },
    created_at: now,
    updated_at: now,
  };
}

function createDronePreset(): Preset {
  const now = new Date().toISOString();
  return {
    ...createBlankPreset(),
    id: `shipped_drone_${crypto.randomUUID().slice(0, 8)}`,
    name: "Drone + B-Roll",
    description: "Lightweight card ingest preset for drone footage, b-roll, stills, maps, and selects.",
    color: "#f2b84b",
    variables: [
      { id: "location", name: "Location", type: "short_text", required: true, default: "Location", options: [] },
      { id: "unit", name: "Unit", type: "dropdown", required: false, default: "", options: ["Drone", "Gimbal", "Handheld"] },
    ],
    root_folder_pattern: "{date}_{location}_{unit}",
    folder_tree: [
      folder("folder_footage", "Footage", "footage", true, [
        folder("folder_drone", "Drone", "footage", true),
        folder("folder_broll", "B-Roll", "footage", true),
      ]),
      folder("folder_photos", "Photos", "photos"),
      folder("folder_maps", "Maps_Permits", "documents"),
      folder("folder_selects", "Selects", "other"),
    ],
    file_rename_pattern: "{location}_{camera}_{clip#}",
    file_type_routing_overrides: { ".jpg": "folder_photos", ".jpeg": "folder_photos", ".dng": "folder_photos", ".pdf": "folder_maps" },
    created_at: now,
    updated_at: now,
  };
}

function createMusicProducerPreset(): Preset {
  const now = new Date().toISOString();
  return {
    ...createBlankPreset(),
    id: `shipped_music_${crypto.randomUUID().slice(0, 8)}`,
    name: "Music Production",
    description: "Session structure for stems, references, mixes, masters, artwork, and docs.",
    color: "#8fb9ff",
    variables: [
      { id: "artist", name: "Artist", type: "short_text", required: true, default: "Artist", options: [] },
      { id: "song", name: "Song", type: "short_text", required: true, default: "Song", options: [] },
    ],
    root_folder_pattern: "{artist}_{song}_{date}",
    folder_tree: [
      folder("folder_session", "01_Session", "documents"),
      folder("folder_audio", "02_Audio", "audio", true, [
        folder("folder_stems", "Stems", "audio", true),
        folder("folder_vocals", "Vocals", "audio", true),
        folder("folder_references", "References", "audio"),
      ]),
      folder("folder_mixes", "03_Mixes", "audio"),
      folder("folder_masters", "04_Masters", "audio"),
      folder("folder_artwork", "05_Artwork", "photos"),
      folder("folder_docs", "06_Docs", "documents"),
    ],
    file_rename_pattern: "{artist}_{song}_{folder_name}_{clip#}",
    file_type_routing_overrides: { ".wav": "folder_audio", ".aiff": "folder_audio", ".mp3": "folder_references", ".jpg": "folder_artwork", ".png": "folder_artwork", ".pdf": "folder_docs" },
    created_at: now,
    updated_at: now,
  };
}

function folder(
  id: string,
  name_pattern: string,
  role: Preset["folder_tree"][number]["role"] = null,
  is_footage_destination = false,
  children: Preset["folder_tree"] = [],
): Preset["folder_tree"][number] {
  return {
    id,
    name_pattern,
    role,
    is_footage_destination,
    children,
    template_files: [],
  };
}
