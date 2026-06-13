# Product Specification: Ingest Pilot

*Working title — change freely.*

## 1. Vision

A cross-platform desktop application that combines three workflows into one tool:

1. **Folder structure templating** (like PostHaste) — define reusable project folder structures with token-based naming
2. **Verified DIT-style ingest** (like Shotput Pro / Hedge / Silverstack) — checksum-verified copy from camera cards to one or more destinations
3. **Lightroom-style rename-on-import** — apply token-based file renaming during ingest using per-clip metadata and user-provided variables

The core insight: existing tools solve one slice of this workflow each, forcing teams to context-switch between multiple apps and leaving room for inconsistent organization. This app removes that gap and enforces consistency through presets authored once and used forever.

## 2. Target Users

Primary: small in-house creative/video teams (reference user: Milestone Church video team).

Secondary: freelance videographers, wedding/event shooters, documentary crews.

Out of scope: Hollywood-tier DIT workflows requiring proxy generation, LUT management, camera-specific CDL handling, ALE export, or insurance-grade MHL v2 compliance. These may be added later but are explicitly not v1 concerns.

## 3. The Core Problem

Existing tools force a tradeoff:

- **PostHaste** creates folder structures but doesn't ingest files, doesn't verify copies, and requires manual destination selection every time.
- **Shotput / Hedge / Silverstack** ingest and verify but don't create meaningful folder structures or rename files with the flexibility a team workflow demands.
- **Lightroom / Bridge** handle photo ingest beautifully but don't apply to video workflows and don't create project-level folder structures.

Teams end up using two or three tools in sequence, with human judgment at every handoff. That judgment is where consistency breaks down — different team members make different choices, projects end up named and organized inconsistently, and finding old work becomes a scavenger hunt.

## 4. Guiding Principles

- **Zero-decision ingest for the end user.** Once a preset is selected, the ingesting team member should face as few choices as possible — ideally just filling in 1-3 variables and clicking Start.
- **Maximum configurability for the preset author.** Presets should be flexible enough to encode any team's workflow without requiring code.
- **One app, one mode.** No separate admin interface. Everyone uses the same app; preset authoring is simply a feature within it. Team members who don't need to create presets just never open the authoring screens.
- **Safety first.** The app never deletes source files. Never. Interrupted jobs are recoverable. Verification is non-optional for the verified-copy path.
- **Local-first, sync-optional.** Presets live on the user's machine. Sharing across a team is supported via a watched shared folder, but doesn't require cloud infrastructure.
- **Run quietly in the background.** The app should feel ambient — always ready, never demanding. Card insertion prompts an ingest; otherwise the app stays out of the way.

## 5. Feature Specification

### 5.1 Preset Authoring

A preset encodes a complete ingest workflow. It consists of:

**Identity**
- Preset name (display)
- Optional description
- Optional icon/color for visual identification

**Root folder pattern**
- Token-based folder name (e.g., `{date}_BaptismStory_{story_name}`)
- The root folder is created at the chosen destination path when ingest starts

**Folder tree**
- A nested tree of subfolders inside the root
- Each folder has a name pattern (can use tokens)
- One folder must be designated the default footage destination
- Folders can contain template files (see 5.5)
- Folders can be conditionally created based on variable values (see 5.3)

**File rename pattern**
- Default pattern applied to files during ingest
- Separate from folder naming
- Can reference all preset-level tokens plus per-clip tokens
- `{folder_name}` token available to inherit the containing folder's resolved name

**Per-folder rename overrides (optional)**
- A specific folder can define its own rename pattern that overrides the default
- Useful when audio files should follow a different convention than video files

**Destination**
- Primary destination path (where the root folder is created)
- Optional secondary destinations for multi-destination copy (up to some reasonable limit — 3-4)
- Destinations can be any local or network-mounted path

**User-defined variables**
- Author adds variables that will be prompted at ingest time
- Each variable has: name, token ID, type, default value (optional), required/optional flag
- Supported types: short text, long text, dropdown (single-select), boolean, date picker (defaults to today)

**File-type routing (optional per-preset override)**
- By default, files route based on global file-type settings (see 5.6)
- A preset can override this routing to put specific extensions in specific folders

### 5.2 Token System

Tokens are the substitution variables used throughout preset patterns.

**Categories:**

*Global tokens* (available in any pattern field):
- `{date}` — today's date, format configurable (default: YYYYMMDD)
- `{year}`, `{month}`, `{day}` — individual date components, zero-padded
- `{preset_name}` — the name of the current preset

*User-defined variable tokens* (available in any pattern field):
- Whatever the preset author defined (e.g., `{story_name}`, `{campus}`)

*Per-clip tokens* (file rename fields only):
- `{camera}` — detected from metadata or user-tagged at ingest
- `{clip#}` — auto-incrementing counter, configurable padding
- `{original_name}` — source filename without extension
- `{capture_date}` — clip capture date from metadata, falls back to file modified date
- `{ext}` — file extension (usually auto-appended, but available if needed)

*Folder-context token* (file rename only):
- `{folder_name}` — the resolved name of the containing folder (lets files inherit folder naming)

**Scope filtering:** The token picker UI only shows tokens valid in the current field. A folder name field won't show per-clip tokens since they can't resolve at folder-creation time.

**Token UI:**
- Token picker displays all valid tokens as clickable chips below each pattern field
- Clicking a chip inserts the token at cursor position
- Slash (`/`) typed in the field opens an inline autocomplete menu as a power-user shortcut
- Inserted tokens render as visual pills within the text field, not as raw `{token}` text
- Pills can be deleted as single units (one keystroke) or dragged to reorder
- Plain text can be typed between pills as literal content
- A live preview below the field shows the resolved output with sample values

**Storage format:** Under the hood, patterns are stored as strings with `{token_id}` syntax. The pill UI is purely a rendering layer. This keeps presets portable and human-readable in JSON.

### 5.3 Conditional Folder Creation

Presets can define conditional folders whose existence depends on variable values.

**Example:** Easter services shot at multiple campuses. Variables include `campus` (dropdown: KLR, FM, TL, etc.). The footage folder contains a conditional subfolder: "If `campus` has a value, create a folder named `{campus}` inside Footage/ and route footage there instead of directly into Footage/."

**Scope for v1:** Simple equality-based conditions on dropdown and boolean variables. The UI exposes this as "Only create this folder if [variable] [is/is not] [value]." More complex logic (AND/OR combinations, regex, comparisons) is v2+.

### 5.4 Folder Tree Editor UI

The authoring UI for folder structures needs to feel better than PostHaste's. Requirements:

- Visual tree representation (nested indentation, expand/collapse)
- Drag-and-drop to reorder folders and nest/unnest them
- Right-click / context menu: Add subfolder, Add template file, Rename, Delete, Duplicate, Mark as footage destination, Set conditional
- Drag-and-drop from the OS file explorer to import an existing folder structure as a starting point
- One folder in the tree is visually marked as the default footage destination (badge/icon)
- Conditional folders are visually marked as conditional (badge/icon)

### 5.5 Template Files

Authors can add files to the folder structure that will be copied into every scaffolded project.

**v1 behavior:**
- Template files are copied as-is to the destination
- Template filename inherits the containing folder's resolved name (plus original extension)
- No modification of file contents (a Premiere project file's internal references are not rewritten)

**Example:** A preset has `Premiere/` folder with a template file `project.prproj`. When scaffolded, the folder resolves to `Premiere/` and the file becomes `Premiere/{folder_name}.prproj` where `{folder_name}` is the parent folder's resolved name.

**Explicitly out of scope for v1:** Rewriting Premiere/AE project internals, generating project files programmatically, token-based rename patterns for template files that differ from their containing folder.

### 5.6 File-Type Routing (Global Settings)

A global settings panel defines default routing by file extension.

**Default categories (editable):**
- Video: `.mov, .mp4, .mxf, .braw, .r3d, .arriraw, .avi, .mts, .m2ts, ...`
- Audio: `.wav, .mp3, .flac, .aac, .aiff, ...`
- Image: `.jpg, .jpeg, .png, .tiff, .tif, .heic, .dng, .raw, .cr2, .cr3, .nef, .arw, ...`
- Documents: `.pdf, .txt, .doc, .docx, ...`
- Other: everything else

Each category has:
- A list of extensions (editable)
- A default target folder name (e.g., "Footage", "Audio", "Photos")

At ingest time, for each incoming file:
1. Check if the preset overrides routing for this extension → use that
2. Else, check global routing → use the mapped folder if it exists in the preset's tree
3. Else, drop the file in the preset's designated footage folder

Sidecar files (XML, THM, CPF, etc. accompanying video clips) follow their parent clip, respecting the "preserve XML" toggle.

### 5.7 The Ingest Flow

**Trigger paths:**
1. Camera card detected → app prompts user
2. User clicks menu bar / tray icon → selects "Ingest from folder..."
3. User opens main window → clicks "New Ingest"

**Prompt sequence (all paths):**
1. Select source (auto-filled if triggered by card detection)
2. Select preset (remembered per-source or defaulted to last used)
3. Fill in preset variables (only the variables this preset defines)
4. Review destinations (primary + any secondaries from preset; user can add/remove secondaries for this job)
5. Review scan results (file count, total size, estimated time, detected cameras)
6. Confirm → ingest starts

**During ingest:**
- Progress bar per destination
- Current file being copied
- Files completed / remaining
- Estimated time remaining
- Verification status per file (not yet copied / copying / verifying / complete / failed)
- Cancel button (safely halts, writes job state for resume)

**After ingest:**
- Success summary: file count, total size, duration, average speed
- Any warnings or errors listed
- "Open Folder" button to jump to the created project
- "View Report" button to open the human-readable report
- MHL file written to the root of the scaffolded project

### 5.8 Checksum and Verification

- Hash algorithm: **xxHash (XXH64 or XXH3-128)** — fast, modern, well-supported by MHL v2
- Every file hashed on read from source
- Copied to destination(s)
- Re-hashed on destination to verify
- If verification fails: retry once, then mark file as failed and continue with remaining files
- Failed files are clearly reported at the end; source files are never deleted, so the user can retry
- MHL file generated per ingest, listing every file and its verified hash
- Human-readable report (HTML or PDF) summarizing the ingest: preset used, variables, source, destinations, file list, hashes, timing, any failures

### 5.9 Rename-During-Ingest Flow

The safe order of operations is important:

1. Hash source file
2. Copy to destination(s) with original filename temporarily
3. Rename copied file to the resolved rename pattern
4. Re-hash renamed file
5. Verify hash matches source hash
6. Record in MHL

Renaming after copy (rather than during the byte stream) keeps the hashing logic simple and avoids race conditions. Filename conflicts (two clips would resolve to the same name) trigger auto-increment suffix: `BAP_Johnson_FX3_001.mov`, `BAP_Johnson_FX3_001-2.mov`.

### 5.10 Multi-Destination Copy

- Up to 3-4 simultaneous destinations
- Each destination is copied and verified independently
- A file is considered successful only when all destinations verify
- If one destination fails while others succeed: report the failure clearly, mark only that destination's copy as failed
- Destinations can be local paths or network-mounted paths; the app doesn't distinguish

### 5.11 Background Agent / Menu Bar App

**macOS:** Menu bar icon (status item) in the top-right area. Click opens a dropdown with: recent ingests, "New Ingest...", "Preferences", "Quit".

**Windows:** System tray icon with equivalent right-click menu.

**On launch (or login, if user enables):**
- App starts minimized to menu bar / tray
- Main window closed
- Begins listening for volume mount events

**On volume mount:**
- App detects new volume
- Checks volume structure for known camera card signatures (DCIM/, PRIVATE/M4ROOT/, CONTENTS/, CLIP/, etc.)
- If recognized as a camera card: show a notification / prompt offering to ingest
- If not recognized: still show a prompt (user can always ingest from any folder), with a "don't ask for this volume again" option that remembers the volume UUID
- User can always manually trigger an ingest via the menu bar, regardless of detection

**Notification prompt:**
- Uses native OS notification or a small floating window (design decision for implementation)
- "New volume detected: [Volume Name]. Ingest?" with Yes / No / Don't ask again for this volume

### 5.12 Preset Storage and Sync

**Local storage (primary):**
- Presets stored as JSON files in `~/Documents/[AppName]/Presets/` (or platform-appropriate equivalent)
- Filename derived from preset name; if renamed, file is renamed

**Import/Export:**
- `.preset` file format (JSON) — can be emailed, Slacked, dropped into shared drives
- Import: drag-and-drop onto app, or File → Import Preset
- Export: right-click preset → Export

**Shared folder sync (optional):**
- User can set a shared folder path in settings (e.g., a Dropbox/Google Drive/SMB-mounted server path)
- App watches that folder for `.preset` files
- Any presets found are made available in the preset list, marked as "Shared"
- Editing a shared preset writes changes back to the shared folder (propagates to the team)
- Local presets and shared presets are both visible in the UI, clearly differentiated
- Conflict resolution: if a local and shared preset have the same name, both appear, disambiguated by origin label

### 5.13 Interruption Recovery

- Before an ingest starts, the app writes a job state file to a reserved location (`~/Library/Application Support/[AppName]/Jobs/[JobID].json` or Windows equivalent)
- The job state tracks: source, destinations, preset used, variables filled, list of files with per-file status (pending/copying/verifying/complete/failed)
- The job state is updated as files complete
- On app launch, any job with incomplete state is detected
- User is prompted: "An ingest from [date] was interrupted. Resume or discard?"
- Resume continues from where it left off, re-verifying files that were mid-copy
- Source files are never touched by the app under any circumstance — they are read-only from the app's perspective

### 5.14 Metadata Bulk Editing

**Explicitly deferred to a future version.** Not in v1.

If revisited later: consider sidecar XMP for keywords (non-destructive, Iconik-compatible) rather than modifying video file metadata directly.

## 6. Non-Goals (v1)

Explicitly out of scope to keep v1 achievable:

- Proxy generation
- LUT application or preview
- Camera-specific metadata ingestion beyond basic tokens (camera model, capture date)
- ALE / CSV export
- Direct Iconik / Frame.io / Kyno integration
- Cloud sync for presets
- Mobile companion app
- Playback / preview of video files within the app
- Multi-user permissions / role-based access
- Modifying template file contents (Premiere XML, AE project internals)
- Auto-delete of source files after verification
- Advanced conditional logic in presets (AND/OR, comparisons, regex)
- Token modifiers (uppercase, date format overrides, etc.)

## 7. Success Criteria

v1 is complete and successful when:

1. A preset can be authored that includes a folder tree, template files, user variables, file rename pattern, and conditional folders.
2. A team member can insert a camera card, pick a preset, fill in 1-3 variables, and walk away while the app performs a verified ingest to the correct destinations with files correctly routed and renamed.
3. The same preset can be shared with another team member via a watched shared folder and used identically on their machine.
4. The app runs natively on macOS and Windows, installs via a standard installer on each, and runs in the background via menu bar / tray.
5. An MHL file and a human-readable report are generated for every ingest.
6. An interrupted ingest can be safely resumed without data loss.

## 8. Glossary

- **DIT:** Digital Imaging Technician — the on-set role responsible for handling footage from camera to storage, including verified copying.
- **MHL:** Media Hash List — industry-standard XML format for recording file hashes during ingest. Produced as a sidecar to the copied media.
- **xxHash:** A fast non-cryptographic hash algorithm widely used in modern DIT workflows. XXH64 is 64-bit; XXH3-128 is 128-bit. Both are dramatically faster than MD5 or SHA-family hashes with comparable reliability for integrity checking.
- **Token:** A substitution variable in a pattern string, written as `{name}` in storage, rendered as a visual pill in the UI.
- **Preset:** A saved, reusable workflow definition — folder structure + rename rules + variables + destinations.
- **Ingest:** The process of copying files from a source (camera card, hard drive, folder) to one or more destinations with verification.
- **Sidecar:** An auxiliary file accompanying a media file, containing metadata (XMP, XML, etc.).
