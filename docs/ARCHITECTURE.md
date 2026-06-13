# Technical Architecture: Ingest Pilot

This document defines the technical approach and structural decisions for the application. It is the companion to `SPEC.md` and should be read alongside it.

## 1. Tech Stack Decisions

### 1.1 Application Framework: Tauri

**Decision:** Tauri 2.x with a Rust backend and a web-technology frontend (React + TypeScript).

**Rationale:**
- Produces genuinely native installers for macOS (`.dmg`, `.app`) and Windows (`.msi`, `.exe`) from a single codebase.
- Binary size is small (10-20MB) vs. Electron (100-200MB).
- Rust backend is ideal for the performance-critical work: hashing, concurrent file I/O, multi-destination writes.
- Web frontend means rich UI development is approachable and the file picker / drag-and-drop / forms patterns used in PostHaste and Lightroom translate directly.
- Native menu bar / system tray support.
- Native volume mount detection via platform APIs is accessible through Rust.
- Single tool (Tauri CLI) handles build, bundle, and installer generation.

**Alternative considered:** Electron + Node.js. Rejected because the performance core (hashing, concurrent I/O) would be slower in Node, the installer would be larger, and Tauri's Rust backend is better suited to the file-handling work that is the heart of this app.

### 1.2 Frontend

- **React 18+** with **TypeScript**
- **Vite** as the build tool (Tauri's default)
- **Tailwind CSS** for styling — fast iteration, consistent design tokens
- **Zustand** for state management — simpler than Redux, appropriate for an app of this size
- **React Router** if multi-page navigation is needed within the main window
- **React DnD** or native HTML5 drag-and-drop for the folder tree editor
- **Framer Motion** (optional) for ingest progress animations
- No UI component library imposed — build custom components for the authoring screens, since they're the product's differentiator

### 1.3 Backend (Rust)

Core Rust crates:
- **`tauri`** — framework
- **`tokio`** — async runtime for concurrent I/O
- **`xxhash-rust`** — XXH64 and XXH3 hashing
- **`serde` + `serde_json`** — preset and job state serialization
- **`notify`** — cross-platform filesystem watching (for the shared presets folder)
- **`walkdir`** — recursive source scanning
- **`chrono`** — date/time handling for tokens and timestamps
- **Platform-specific:**
  - macOS: `core-foundation` and `io-kit-sys` for DiskArbitration (volume mount events)
  - Windows: `windows` crate for WMI or `WM_DEVICECHANGE` listening
  - Consider `system_shutdown` or similar for graceful handling

### 1.4 Data Formats

- **Presets:** JSON files with `.preset` extension. Schema versioned from day one.
- **Job state (for resume):** JSON files with `.job` extension in an application support directory.
- **MHL output:** XML per the MHL specification (either v1.1 or v2). Library: consider writing minimal XML manually or using `quick-xml`.
- **Reports:** HTML generated from a template, optionally renderable to PDF later (not v1).
- **Settings:** JSON in the application support directory.

## 2. Data Models

These are the core schemas. Rust structs and TypeScript types should be generated in parallel (consider `ts-rs` or manual duplication with careful review).

### 2.1 Preset Schema (v1)

```jsonc
{
  "schema_version": 1,
  "id": "uuid-v4",
  "name": "Baptism Story",
  "description": "Standard template for baptism story shoots",
  "icon": "video-camera",
  "color": "#4F46E5",

  "variables": [
    {
      "id": "story_name",
      "name": "Story Name",
      "type": "short_text",
      "required": true,
      "default": ""
    },
    {
      "id": "campus",
      "name": "Campus",
      "type": "dropdown",
      "required": true,
      "options": ["KLR", "FM", "TL", "SL"],
      "default": "KLR"
    },
    {
      "id": "shoot_date",
      "name": "Shoot Date",
      "type": "date",
      "required": true,
      "default": "today"
    },
    {
      "id": "include_audio_folder",
      "name": "Include Audio Folder",
      "type": "boolean",
      "required": false,
      "default": true
    }
  ],

  "root_folder_pattern": "{date}_BaptismStory_{story_name}",

  "folder_tree": [
    {
      "id": "folder_footage",
      "name_pattern": "Footage",
      "is_footage_destination": true,
      "children": [
        {
          "id": "folder_campus",
          "name_pattern": "{campus}",
          "condition": {
            "type": "variable_has_value",
            "variable_id": "campus"
          },
          "is_footage_destination": true,
          "children": []
        }
      ]
    },
    {
      "id": "folder_audio",
      "name_pattern": "Audio",
      "condition": {
        "type": "variable_equals",
        "variable_id": "include_audio_folder",
        "value": true
      },
      "children": []
    },
    {
      "id": "folder_premiere",
      "name_pattern": "Premiere",
      "children": [],
      "template_files": [
        {
          "source_path": "/path/to/template.prproj",
          "name_from_folder": true
        }
      ]
    }
  ],

  "file_rename_pattern": "{folder_name}_{camera}_{clip#}",
  "clip_number_padding": 3,

  "per_folder_rename_overrides": {
    "folder_audio": "AUDIO_{original_name}"
  },

  "destinations": {
    "primary": "/Volumes/MediaServer/Video/Stories/Baptisms/",
    "secondaries": []
  },

  "file_type_routing_overrides": {
    ".wav": "folder_audio",
    ".mp3": "folder_audio"
  },

  "preserve_xml_sidecars": true,

  "created_at": "2026-04-20T10:00:00Z",
  "updated_at": "2026-04-20T10:00:00Z"
}
```

### 2.2 Job State Schema

```jsonc
{
  "schema_version": 1,
  "job_id": "uuid-v4",
  "created_at": "2026-04-20T14:30:00Z",
  "status": "in_progress",

  "preset_snapshot": { /* full preset JSON at time of ingest */ },
  "variable_values": {
    "story_name": "Johnson",
    "campus": "KLR",
    "shoot_date": "2026-04-20",
    "include_audio_folder": true
  },

  "source_path": "/Volumes/A001_SONY/",
  "destinations": [
    "/Volumes/MediaServer/Video/Stories/Baptisms/20260420_BaptismStory_Johnson/",
    "/Volumes/BackupDrive/Baptisms/20260420_BaptismStory_Johnson/"
  ],

  "resolved_root_folder": "20260420_BaptismStory_Johnson",

  "files": [
    {
      "source_path": "/Volumes/A001_SONY/PRIVATE/M4ROOT/CLIP/C0001.MP4",
      "destination_subpath": "Footage/KLR/",
      "target_filename": "20260420_BaptismStory_Johnson_FX3_001.MP4",
      "source_hash": "xxh3:abc123...",
      "destination_hashes": {
        "/Volumes/MediaServer/.../": "xxh3:abc123...",
        "/Volumes/BackupDrive/.../": null
      },
      "status": "verifying",
      "size_bytes": 4823749012,
      "error": null
    }
  ],

  "summary": {
    "total_files": 47,
    "completed": 12,
    "failed": 0,
    "total_bytes": 98234982348,
    "bytes_copied": 24983498203
  }
}
```

### 2.3 Settings Schema

```jsonc
{
  "schema_version": 1,
  "app": {
    "launch_at_login": false,
    "minimize_to_tray_on_close": true,
    "show_notifications": true
  },
  "presets": {
    "local_directory": "~/Documents/IngestPilot/Presets/",
    "shared_directory": null,
    "shared_sync_enabled": false
  },
  "file_type_routing": {
    "video": {
      "extensions": [".mov", ".mp4", ".mxf", ".braw", ".r3d", ".arriraw", ".avi", ".mts", ".m2ts"],
      "default_folder": "Footage"
    },
    "audio": {
      "extensions": [".wav", ".mp3", ".flac", ".aac", ".aiff"],
      "default_folder": "Audio"
    },
    "image": {
      "extensions": [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".heic", ".dng", ".raw", ".cr2", ".cr3", ".nef", ".arw"],
      "default_folder": "Photos"
    },
    "document": {
      "extensions": [".pdf", ".txt", ".doc", ".docx"],
      "default_folder": "Documents"
    }
  },
  "ingest_defaults": {
    "hash_algorithm": "xxh3_128",
    "preserve_xml_sidecars": true,
    "verify_after_copy": true
  },
  "dismissed_volumes": ["volume-uuid-1", "volume-uuid-2"]
}
```

## 3. Module Structure

### 3.1 Rust (src-tauri/src/)

```
src-tauri/src/
├── main.rs                    // Tauri entry, window management
├── commands/                  // Tauri command handlers (exposed to frontend)
│   ├── presets.rs            // CRUD for presets
│   ├── ingest.rs             // Start/cancel/resume ingest jobs
│   ├── scan.rs               // Scan source for file inventory
│   ├── settings.rs           // Settings read/write
│   └── system.rs             // Volume detection, file picker
├── core/
│   ├── preset.rs             // Preset data model, validation
│   ├── token.rs              // Token resolution engine
│   ├── condition.rs          // Conditional evaluation
│   ├── folder_tree.rs        // Folder tree resolution (preset + variables → concrete paths)
│   ├── file_routing.rs       // File-type to folder routing logic
│   ├── job.rs                // Job state model and persistence
│   ├── hash.rs               // xxHash wrapper
│   └── mhl.rs                // MHL file generation
├── ingest/
│   ├── scanner.rs            // Source directory scan, file inventory
│   ├── engine.rs             // Main ingest orchestrator
│   ├── copier.rs             // Concurrent copy with hashing
│   ├── verifier.rs           // Post-copy verification
│   └── report.rs             // HTML report generation
├── platform/
│   ├── mod.rs
│   ├── macos.rs              // DiskArbitration volume events
│   └── windows.rs            // WM_DEVICECHANGE / WMI volume events
├── sync/
│   └── shared_presets.rs     // Watched folder sync
└── lib.rs                     // Module exports
```

### 3.2 Frontend (src/)

```
src/
├── main.tsx
├── App.tsx                     // Root component, routing
├── pages/
│   ├── Home.tsx                // Recent ingests, quick start
│   ├── Presets.tsx             // Preset list
│   ├── PresetEditor.tsx        // Preset authoring
│   ├── IngestDialog.tsx        // Pre-ingest: pick preset, fill variables, confirm
│   ├── IngestProgress.tsx      // During-ingest: live progress
│   ├── IngestSummary.tsx       // Post-ingest: summary, report link
│   └── Settings.tsx            // Global settings
├── components/
│   ├── FolderTreeEditor/       // Drag-drop tree editor for preset authoring
│   ├── TokenPicker/            // Chip picker + slash menu + pill renderer
│   ├── PatternInput/           // Text field with token pill rendering
│   ├── VariableFormBuilder/    // UI to define preset variables
│   ├── VariableFormRenderer/   // UI to fill in variables at ingest time
│   ├── ProgressBar/
│   └── [other shared UI]
├── stores/
│   ├── presetStore.ts          // Zustand store for presets
│   ├── ingestStore.ts          // Zustand store for active ingest job
│   └── settingsStore.ts
├── lib/
│   ├── tauri.ts                // Typed wrappers around Tauri commands
│   ├── tokenResolver.ts        // Client-side token resolution for previews
│   └── types.ts                // Shared TypeScript types
└── styles/
    └── index.css
```

### 3.3 Separation of Concerns

- **Rust owns:** the filesystem, hashing, verification, platform-specific volume detection, preset persistence, job state persistence.
- **Frontend owns:** all UI, preset authoring interactions, token preview rendering, ingest dialog flow, progress visualization.
- **Tauri commands** are the only bridge. Keep commands narrow and well-typed.

## 4. Concurrency Model

### 4.1 Ingest Concurrency

- Files are processed concurrently using a bounded async task pool (Tokio)
- Pool size defaults to 4 concurrent files but is configurable
- For each file: (1) hash source, (2) copy to all destinations concurrently, (3) rename at destinations, (4) verify all destinations, (5) update job state
- Job state updates are serialized through a single writer task to avoid corruption
- Frontend receives progress updates via Tauri events (emitted from backend) on a fixed interval (~250ms) to avoid UI flooding

### 4.2 Background Agent

- Volume detection runs on a platform-specific background task
- Volume events are dispatched to the frontend via Tauri events
- Frontend decides whether to show the ingest prompt based on settings and volume dismissal state

## 5. Platform-Specific Concerns

### 5.1 macOS

- **Volume mount detection:** DiskArbitration framework. Register a callback for `kDADiskDescriptionVolumePathKey` changes.
- **Launch at login:** `SMLoginItemSetEnabled` or the newer ServiceManagement APIs.
- **Menu bar:** Tauri's `SystemTray` API.
- **Code signing:** Apple Developer account ($99/year) required for distribution without Gatekeeper warnings. Optional for internal team use; team members can right-click → Open the first time.
- **Notarization:** Required for distribution outside the team; also requires Apple Developer account.

### 5.2 Windows

- **Volume mount detection:** Listen for `WM_DEVICECHANGE` messages with `DBT_DEVICEARRIVAL` events, or use WMI with `__InstanceCreationEvent` on `Win32_LogicalDisk`.
- **Launch at login:** Registry entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` or Task Scheduler.
- **System tray:** Tauri's `SystemTray` API.
- **Code signing:** EV certificate recommended ($200-400/year) for smooth SmartScreen behavior. Self-signed works internally; users will see SmartScreen warnings on first run.
- **Installer:** MSI via Tauri's WiX bundler.

### 5.3 Filesystem Differences

- Path separators: abstract via Rust's `PathBuf` and `std::path::MAIN_SEPARATOR`. Never hardcode `/` or `\`.
- Case sensitivity: macOS is case-insensitive by default (APFS), Windows is case-insensitive (NTFS). Linux filesystems are case-sensitive. Assume case-insensitive but preserve case in filenames.
- Forbidden characters in filenames: Windows is stricter (`< > : " / \ | ? *`). The token resolver must sanitize resolved filenames for Windows compatibility even on macOS (so shared paths work on both).
- Max path length: Windows has historical 260-char limits; use long-path support where possible. Warn the user if resolved paths exceed reasonable length.
- Network mounts: Treat identically to local paths; don't special-case. Be resilient to disconnection (timeout errors should be handled gracefully).

## 6. Safety Invariants

These are non-negotiable in the ingest engine:

1. **Source files are never written to.** The app opens source files read-only. No exceptions.
2. **Source files are never deleted by the app.** Not after verification, not ever. The user clears cards manually.
3. **Job state is written before any copy begins** and updated atomically (write to temp file, rename) to prevent corruption.
4. **Verification failure does not abort the job.** Failed files are marked, reported, and the rest of the ingest continues.
5. **Hash-then-copy-then-rename-then-verify is the required order** — never rename before verification, never skip verification for the "verified copy" path.
6. **MHL is written after all files complete** but partial MHL state is stored in job state so resume works correctly.

## 7. Testing Strategy

- **Unit tests (Rust):** Token resolution, condition evaluation, folder tree resolution, file-type routing, hash computation, MHL generation, preset schema validation.
- **Unit tests (TypeScript):** Token picker interactions, pattern input rendering, client-side preview resolution.
- **Integration tests (Rust):** Full ingest flow against a temp filesystem with fake source files and fake destinations. Verify hashes, verify job state, verify MHL output.
- **Manual testing:** Card detection, multi-destination copy to real drives, large file handling, interruption recovery. This requires real hardware so it's manual.
- **What not to test heavily:** UI components that are pure visual polish. Settings panels. Onboarding flows. These are cheaper to verify by using the app.

## 8. Open Technical Questions (for implementation)

These are decisions to make during the build, not before:

1. Exact notification strategy (native OS notification vs. floating mini-window) for volume detection prompt.
2. Whether to render reports as HTML only or invest in PDF output day one.
3. How to detect "camera name" across a broad range of cameras — build a registry of metadata paths per camera manufacturer, or fall back to user-tagged source.
4. Exact UI for the token picker pill rendering — spec calls for it but the interaction details benefit from prototyping.
5. Whether conditional folders should support nested conditions in v1 or only flat per-folder conditions.
