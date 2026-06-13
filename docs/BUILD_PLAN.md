# Build Plan: Ingest Pilot

This document is your roadmap for building the app with Claude Code. Every milestone is sized to fit comfortably within a single Claude Code session's context window. You can work through them in order, one (or sometimes two) per night.

## How to Use This Document with Claude Code

### At the start of every session

Paste this (or something like it) as your opening message:

> We're building Ingest Pilot. Before we start, please read `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/BUILD_PLAN.md` in full. The last completed milestone was **M[X]**. Today we're working on **M[Y]**: [one-sentence summary]. At the end of the session, update `BUILD_PLAN.md` with what you completed, what remains, and any decisions or deviations from the plan.

This primes Claude Code with the full context and establishes the discipline of updating the plan as you go.

### During the session

- **Commit often.** After every meaningful increment (e.g., "token resolver passes tests"), commit. If Claude Code goes sideways you can roll back without losing hours.
- **Let Claude Code write tests first** where the logic is non-trivial (token resolution, condition evaluation, hashing). These are the correctness core.
- **Don't let Claude Code scope-creep.** If it wants to also "improve error handling throughout the codebase" mid-milestone, say no. Finish the milestone, commit, start a new session for polish work.
- **If you hit a context wall,** stop the session, have Claude Code update `BUILD_PLAN.md` with a handoff note, commit, and start fresh.

### At the end of every session

Ask Claude Code to:

1. Run the test suite and confirm everything passes.
2. Commit all changes with a clear message referencing the milestone.
3. Update `BUILD_PLAN.md` — mark the milestone complete (or note what's remaining), add a "Session Notes" subsection describing any decisions made, deviations from the plan, or things to revisit.

### General Claude Code tips for this project

- **Keep code organized per the module structure in ARCHITECTURE.md.** If Claude Code wants to deviate, push back unless there's a clear reason.
- **Rust and TypeScript types should stay in sync.** When you change a Rust struct that crosses the Tauri boundary, update the corresponding TypeScript type in the same commit.
- **Avoid premature abstraction.** Build concretely for the specified feature; refactor to abstraction only when a second use case actually appears.
- **Don't let Claude Code install dependencies without asking you first.** Dependency bloat adds up.

---

## Milestone List

Each milestone includes: goal, deliverables, test criteria, and an estimated session count. Sessions are sized for roughly 1.5-3 hours of focused work.

---

### M1: Project Scaffold and Build Pipeline

**Estimated sessions:** 1

**Goal:** A working Tauri + React + Rust project that builds and runs on your dev machine. Installer generation verified.

**Deliverables:**
- Tauri 2.x project initialized with React + TypeScript + Vite
- Tailwind CSS configured
- Zustand installed and set up with a placeholder store
- Rust backend has a placeholder Tauri command that the frontend can call (e.g., `greet(name: string) -> string`)
- Frontend calls the command on button click and displays the result
- `cargo tauri build` produces installers for your platform (verify on your OS; cross-compilation for the other can come later)
- Repository structure matches ARCHITECTURE.md §3 (even if files are empty placeholders)
- `.gitignore` configured for Rust, Node, Tauri builds
- README.md with a short "how to run" section
- `docs/` folder contains `SPEC.md`, `ARCHITECTURE.md`, `BUILD_PLAN.md`

**Test criteria:**
- `npm run tauri dev` launches a window and the placeholder command roundtrips
- `npm run tauri build` succeeds and produces an installer/app
- Installing and running the built app works

**Session opener:**
> We're at the start of the project. Read `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`. Today is M1: Project Scaffold and Build Pipeline. Walk me through Tauri setup, stopping for my input on package name, identifier, etc.

---

### M2: Preset Data Model and Storage

**Estimated sessions:** 1

**Goal:** Preset schema defined in Rust with full serialization, plus Tauri commands for CRUD on local preset files.

**Deliverables:**
- Rust `Preset` struct and all nested types (variables, folder tree, conditions, etc.) per ARCHITECTURE.md §2.1
- Serde serialization/deserialization with schema versioning
- Unit tests for preset serialization: load a known JSON, assert it parses; serialize a preset, assert JSON matches
- Tauri commands: `list_presets()`, `get_preset(id)`, `save_preset(preset)`, `delete_preset(id)`, `import_preset(file_path)`, `export_preset(id, target_path)`
- Preset storage directory created on first run at `~/Documents/[AppName]/Presets/`
- TypeScript types for `Preset` matching the Rust struct
- Thin React page `Presets.tsx` that lists all presets by name (no editor yet — just a list, with "Delete" working and "Import" accepting a drag-and-dropped file)
- Two hand-written sample preset JSON files checked into `examples/` for testing

**Test criteria:**
- Unit tests pass
- Sample presets load and display in the UI
- Deleting a preset removes the file and refreshes the list
- Importing a `.preset` file adds it to the list

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M1 is complete. Today is M2: Preset Data Model and Storage. Start with the Rust structs and tests before touching the frontend.

---

### M3: Token System and Pattern Input Component

**Estimated sessions:** 2

**Goal:** The token resolver engine (Rust) and the token-pill pattern input component (React) — both fundamental building blocks used by everything after.

**Deliverables (Session 1 — Rust side):**
- Token resolver module: given a pattern string and a context (resolved variable values, clip metadata, folder name, etc.), returns a resolved string
- Support for all v1 tokens listed in SPEC.md §5.2
- Date formatting with a reasonable default (YYYYMMDD) — no configurable format yet
- Clip number padding
- Filename character sanitization (Windows-safe by default)
- Comprehensive unit tests: every token type, nested tokens, unresolved token handling (error or placeholder — decide and document)
- Tauri command `preview_pattern(pattern, context) -> resolved_string` for UI previews

**Deliverables (Session 2 — React side):**
- `TokenPicker` component: displays chips for available tokens, filtered by scope ("folder" vs "filename" vs "any")
- `PatternInput` component: text input that renders tokens as pills
  - Clicking a chip inserts a pill at cursor
  - Typing `/` opens an inline autocomplete menu
  - Pills delete as single units
  - Plain text typed between pills is preserved
  - Live preview below the input, calling `preview_pattern` with sample context
- Storybook-style test page (`/dev/pattern-input`) to visually exercise the component
- Unit tests for the pattern-string-to-pill-tokens parser and vice versa

**Test criteria:**
- Rust tests cover all token types
- You can interactively build a pattern like `{date}_{story_name}_{camera}_{clip#}` by clicking chips, and the preview resolves correctly
- Typing `/` brings up the autocomplete
- Deleting a pill removes it cleanly

**Session opener (Session 1):**
> Continuing Ingest Pilot. Read the three docs. M2 is complete. Today is M3 Session 1: Rust token resolver. Focus on the Rust implementation and tests. No frontend work.

**Session opener (Session 2):**
> Continuing Ingest Pilot. Read the three docs. M3 Session 1 is complete. Today is M3 Session 2: The React `TokenPicker` and `PatternInput` components. These are the most important UI components in the app — invest in getting them right.

---

### M4: Preset Editor UI — Variables and Basic Fields

**Estimated sessions:** 1-2

**Goal:** The top half of the preset editor — name, description, variables, and basic pattern fields (root folder pattern, file rename pattern, destinations). Folder tree comes next milestone.

**Deliverables:**
- `PresetEditor.tsx` page, routed from the preset list ("New" and "Edit")
- Identity section: name, description (both with plain inputs)
- Variables section: add/remove/reorder variables; each variable has a form for editing name, token ID (auto-generated from name, editable), type, required, default, and type-specific settings (dropdown options, etc.)
- Root folder pattern: `PatternInput` with "global" token scope plus the variables defined above
- File rename pattern: `PatternInput` with "file" token scope plus variables
- Destinations: path picker for primary, "Add Secondary" for up to 3 more
- Save / Cancel buttons; Save calls `save_preset` Tauri command
- Unsaved-changes warning when navigating away
- No folder tree yet (placeholder section saying "Folder tree coming in M5")

**Test criteria:**
- Can create a new preset from scratch, save it, and see it in the list
- Can edit an existing preset and save changes
- Variables added earlier show up as tokens in the pattern fields
- Destination paths open a native folder picker

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M3 is complete. Today is M4: Preset Editor UI — Variables and Basic Fields. The folder tree is *not* in scope for today — leave a placeholder section for it. Focus on getting the form UX right.

---

### M5: Folder Tree Editor

**Estimated sessions:** 2

**Goal:** The drag-and-drop folder tree editor, the heart of preset authoring.

**Deliverables (Session 1 — Core tree editor):**
- `FolderTreeEditor` component: renders a nested tree of folders
- Each folder row: name (as `PatternInput`), expand/collapse, badges (footage destination, conditional), action menu
- Add subfolder, delete, duplicate, rename, mark as footage destination
- Drag-and-drop to reorder siblings and change nesting (use `@dnd-kit/core` or similar)
- State lives in the preset editor's form state, persists on save
- Visual indication of the designated footage destination folder
- Unit test coverage for the tree manipulation logic (add, remove, move, reparent)

**Deliverables (Session 2 — Conditions and template files):**
- Conditional folder support: UI to configure a condition on a folder ("only create if variable X equals Y" or "only create if variable X has a value")
- Conditions stored on the folder node per the schema
- Backend: when resolving the folder tree for a job, evaluate conditions and skip folders whose conditions don't match
- Template file support: attach one or more files to a folder; at scaffold time these files get copied in with the folder's resolved name (plus original extension)
- Unit test: resolve a folder tree with mixed conditions and template files against sample variable values, assert the resulting path list is correct

**Test criteria:**
- Can build a realistic folder tree (like the Baptism Story example) entirely through the UI
- Conditional folders can be toggled and the UI makes the condition visible
- Saving and reloading the preset preserves the full tree
- Tree manipulation tests pass

**Session opener (Session 1):**
> Continuing Ingest Pilot. Read the three docs. M4 is complete. Today is M5 Session 1: the drag-and-drop folder tree editor. Get the core tree UX working — conditions and template files are Session 2.

**Session opener (Session 2):**
> Continuing Ingest Pilot. Read the three docs. M5 Session 1 is complete. Today is M5 Session 2: conditional folders and template file support. Both frontend authoring UI and backend resolution logic.

---

### M6: Folder Scaffolding Engine (Without Ingest)

**Estimated sessions:** 1

**Goal:** Given a preset and filled-in variables, create the folder structure on disk. This is "PostHaste done" — no ingest yet, just scaffolding. A shippable milestone on its own.

**Deliverables:**
- Rust module `folder_tree::resolve` that takes a preset and a variable value map, returns a list of (absolute_path, is_footage_destination, template_files) tuples
- Rust module to actually create those folders and copy template files
- Tauri command `scaffold_project(preset_id, variable_values, destination_override?) -> resolved_root_path`
- UI: an "Ingest" dialog (will expand in later milestones) that currently just does scaffolding
  - Pick a preset from a dropdown
  - Variable form renders based on the preset's variable definitions (`VariableFormRenderer` component)
  - "Create Folders" button calls `scaffold_project`
  - Success state shows the created path and an "Open Folder" button
- Variable validation: required variables must be filled before submit
- Integration test: create a preset, call scaffold, assert folder structure exists on disk

**Test criteria:**
- End-to-end: create a preset in the UI, click New Ingest, fill variables, click Create Folders, see the folders on disk
- Conditional folders correctly create or skip
- Template files appear with correct names
- Path sanitization prevents invalid characters in resolved folder names

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M5 is complete. Today is M6: the folder scaffolding engine. By end of session we should be able to create folder structures on disk from presets — essentially a PostHaste replacement, before any actual ingest.

---

### M7: Source Scanner and Manual Ingest (No Checksum Yet)

**Estimated sessions:** 1-2

**Goal:** End-to-end manual ingest flow — pick a source folder, app scans it, files get copied to the scaffolded structure with the rename pattern applied, routed by file type.

**Deliverables:**
- Rust `scanner` module: recursively scans a source directory, returns a list of files with size, extension, modified date
- Sidecar detection: XML/THM/CPF files paired with their parent clip
- File-type routing logic: for each scanned file, determine its destination folder based on preset routing overrides + global settings
- Rust `copier` module: simple non-verified copy (hashing comes in M8)
- Rename at destination using the file rename pattern (or per-folder override)
- Duplicate filename handling: auto-increment suffix
- Frontend: extend the ingest dialog
  - After preset + variables are filled, pick a source folder
  - Scan runs, shows file count, total size, breakdown by type
  - "Start Ingest" kicks off the copy
  - Progress screen shows current file, files completed, bytes copied
  - Summary screen on completion
- Global settings page (basic): configure file-type routing categories and extensions

**Test criteria:**
- Create a folder of dummy test files (various extensions), run an ingest, verify files land in the right folders with the right names
- Sidecar files follow their parent clip and respect the preserve-XML toggle
- Filename collisions get suffixed correctly

**Session opener (Session 1):**
> Continuing Ingest Pilot. Read the three docs. M6 is complete. Today is M7 Session 1: source scanner and basic copy engine. No hashing yet — that's M8. Focus on scan, route, copy, rename.

**Session opener (Session 2):**
> Continuing Ingest Pilot. Read the three docs. M7 Session 1 is complete. Today is M7 Session 2: wire up the ingest UI end to end — dialog, progress, summary.

---

### M8: Checksum Verification and MHL Output

**Estimated sessions:** 1

**Goal:** Upgrade the manual ingest to a real verified ingest with xxHash and MHL.

**Deliverables:**
- Rust `hash` module: streaming xxHash (XXH3-128) computation
- Ingest engine updated: hash on source read, copy, rename, re-hash at destination, verify match
- Failed verifications: retry once, then mark as failed, continue with remaining files
- `mhl` module: generate an MHL (v2 preferred) file listing all verified files with their hashes, sizes, timestamps
- Human-readable HTML report: preset used, variables, source, destinations, file list with hashes, timings, any failures
- MHL written to the scaffolded root folder
- Report saved alongside MHL; "View Report" button in summary opens it in the default browser
- Integration test: full ingest with verification on temp filesystem, assert MHL is correct

**Test criteria:**
- Ingest reports a hash for every file, written to MHL
- Deliberately corrupting a destination file (simulated) triggers verification failure and it's reported correctly
- HTML report opens and is readable

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M7 is complete. Today is M8: checksum verification and MHL output. The ingest engine becomes a real verified-copy DIT tool by end of session.

---

### M9: Multi-Destination Copy

**Estimated sessions:** 1

**Goal:** Support copying to multiple destinations simultaneously, verifying each independently.

**Deliverables:**
- Ingest engine upgraded to copy to N destinations concurrently
- Each destination hashed and verified independently
- Per-destination progress in the UI
- Summary shows success/failure per destination
- MHL written to each destination root
- UI: destinations list in the ingest dialog, "Add Destination" button, removable secondaries (primary is fixed from preset)
- Graceful handling of one destination being slower/failing while others succeed

**Test criteria:**
- Ingest to two destinations, both verify correctly
- Make one destination read-only or disconnect it mid-copy; verify the other completes and the failure is reported

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M8 is complete. Today is M9: multi-destination copy with independent verification per destination.

---

### M10: Interruption Recovery

**Estimated sessions:** 1

**Goal:** Jobs that get interrupted (app quit, power loss) can be safely resumed on next launch.

**Deliverables:**
- Job state persistence (per ARCHITECTURE.md §2.2): written atomically on every file status change
- Job state directory in the platform-appropriate app support location
- On app launch: scan for incomplete jobs, prompt the user to resume or discard each
- Resume logic: skip files already verified, re-verify files that were mid-copy, continue from where it left off
- Discard: mark the job as abandoned, leave scaffolded files in place (never delete)
- "Ingest History" page listing past jobs with status (complete/failed/abandoned)
- Integration test: start a job, kill the process mid-ingest, restart, resume, verify final state is correct

**Test criteria:**
- Kill the app during an ingest; relaunch; the prompt appears; resume; ingest completes
- Job state file is never corrupted by concurrent writes

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M9 is complete. Today is M10: interruption recovery. Safety-critical — invest in tests.

---

### M11: Background Agent — Menu Bar / System Tray

**Estimated sessions:** 1

**Goal:** The app runs in the background with a menu bar icon (Mac) / tray icon (Windows). Users can trigger ingests without opening the main window.

**Deliverables:**
- Tauri SystemTray configured for both platforms
- Menu items: "New Ingest from Folder...", "Open Main Window", "Recent Ingests" submenu (last 5), "Preferences", "Quit"
- Closing the main window minimizes to tray (per settings); Quit actually exits
- Launch-at-login setting wired up for both platforms
- "New Ingest from Folder..." opens a lightweight ingest dialog without requiring the main window

**Test criteria:**
- Mac: icon appears in menu bar, menu items work
- Windows: icon in system tray, menu items work
- Close main window; app stays alive in tray; reopen via tray; works
- Launch-at-login setting actually launches on login

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M10 is complete. Today is M11: background agent, menu bar, system tray. Cross-platform UI primitive — use Tauri's SystemTray API.

---

### M12: Volume Detection and Auto-Prompt

**Estimated sessions:** 2

**Goal:** The app detects when a new volume (especially a camera card) is mounted and prompts the user to ingest. This is the feature that makes it feel magical.

**Deliverables (Session 1 — platform detection):**
- Rust `platform` module with `macos.rs` and `windows.rs`
- macOS: DiskArbitration-based volume mount listener
- Windows: WMI or WM_DEVICECHANGE-based volume mount listener
- Both emit a unified `VolumeMountedEvent` with: volume name, mount path, volume UUID, filesystem type
- Camera card detection heuristic: check for known folder signatures (DCIM, PRIVATE/M4ROOT, CONTENTS, CLIP, XDROOT, DCIM/100CANON, etc.)
- Tauri event emitted to frontend on mount
- Unit tests on the heuristic logic (given a mocked filesystem, does it classify correctly)

**Deliverables (Session 2 — UI and dismissal):**
- Frontend listens for volume events
- On mount: native OS notification "New volume detected: [name]. Ingest?"
- Click notification → opens ingest dialog pre-filled with that source path
- "Don't ask again for this volume" option stored in settings by volume UUID
- Volume detection setting (enable/disable) in preferences
- Manual "Ingest from Folder..." always works regardless of detection

**Test criteria:**
- Insert a real SD card: notification fires, clicking opens ingest with source prefilled
- Insert a random USB drive: notification fires, dismiss-and-don't-ask-again works
- Re-insert dismissed drive: no notification

**Session opener (Session 1):**
> Continuing Ingest Pilot. Read the three docs. M11 is complete. Today is M12 Session 1: platform-specific volume mount detection for macOS and Windows. Rust only; no UI yet.

**Session opener (Session 2):**
> Continuing Ingest Pilot. Read the three docs. M12 Session 1 is complete. Today is M12 Session 2: UI for volume detection prompts and the "don't ask again" dismissal system.

---

### M13: Shared Folder Preset Sync

**Estimated sessions:** 1

**Goal:** Team members can share presets via a watched shared folder.

**Deliverables:**
- Settings: shared presets folder path (optional) + enable toggle
- Rust `sync::shared_presets` module: uses `notify` crate to watch the shared folder for `.preset` file changes
- Presets in the shared folder appear in the preset list, labeled as "Shared"
- Local and shared presets are visually differentiated
- Editing a shared preset writes back to the shared folder
- Deleting a shared preset deletes from the shared folder (with a confirmation warning that it affects the whole team)
- Name collision handling: local preset named "X" and shared preset named "X" both appear, suffixed to disambiguate

**Test criteria:**
- Point the shared folder at a test directory; drop a `.preset` file in it; it appears in the UI within a few seconds
- Edit the shared preset; the file in the shared folder updates
- Stop the app, modify the shared file externally; restart the app; changes reflected

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. M12 is complete. Today is M13: shared folder preset sync using the `notify` crate.

---

### M14: Polish, Settings, and Edge Cases

**Estimated sessions:** 2-3

**Goal:** Everything that didn't fit into earlier milestones but needs to exist for a polished v1.

**Deliverables (spread across sessions as fits):**
- Full Settings page: all settings from ARCHITECTURE.md §2.3 exposed
- Date token default format setting for `{date}` in folder and filename patterns
- File-type routing editor: add/remove categories, edit extension lists
- Preset list: search/filter, sort, "Duplicate" action
- Preset editor: unsaved-changes indicator, confirmation on delete
- Ingest history: searchable list of past jobs with links to reports
- Error messages throughout: every error the user might see should be human-readable and actionable
- Empty states: first-run experience, no presets yet, etc.
- Icon design (or placeholder) for the app
- About dialog with version number
- Update `README.md` with install instructions for your team

**Session openers:** Vary per session; pick the top 2-3 items and tackle those.

---

### M15: Build, Sign, and Distribute

**Estimated sessions:** 1-2

**Goal:** Produce installers your team can actually install.

**Deliverables:**
- macOS: `.dmg` installer. If you have an Apple Developer account, sign and notarize; otherwise document the "right-click Open" workaround for unsigned apps
- Windows: `.msi` installer. If you have a code signing cert, sign; otherwise document the SmartScreen workaround
- Installation tested on a clean machine for each platform
- Uninstallation tested
- Team-facing installation instructions

**Session opener:**
> Continuing Ingest Pilot. Read the three docs. Core feature work is complete through M14. Today is M15: build and distribution. Walk me through Tauri's bundling options for dmg and msi; we'll decide on signing.

---

## Out-of-Scope / v2 Ideas

Park these for after v1 ships:

- Metadata editing on ingest (date offset, keywords via sidecar XMP)
- Iconik direct integration
- Proxy generation
- Token modifiers (`{date:YYYY-MM-DD}`, `{name:uppercase}`)
- Advanced conditional logic (AND/OR, comparisons)
- Template file rename patterns independent of containing folder
- Cloud preset sync (beyond shared folder)
- PDF report output
- Preview/playback of clips within the app
- Camera-specific metadata enrichment (ARRI CDL, RED RMD, etc.)

## Session Notes Log

*Claude Code will append to this section at the end of each session.*

### [Template for each entry]

**Date:** YYYY-MM-DD
**Milestone:** MX
**Status:** Complete / In Progress / Blocked
**What was done:**
- ...

**What remains:**
- ...

**Decisions and deviations:**
- ...

**Notes for next session:**
- ...

### 2026-04-24

**Date:** 2026-04-24
**Milestone:** M1 / M2 start
**Status:** M1 complete; M2 in progress
**What was done:**
- Scaffolded Tauri 2 + React + TypeScript + Rust app.
- Added Tailwind styling and a modern rounded app shell inspired by the reference UI.
- Copied SPEC, ARCHITECTURE, and BUILD_PLAN into `docs/`.
- Added `DESIGN_DIRECTION.md`.
- Verified frontend build, Rust tests, and Windows Tauri bundle.
- Added live page navigation so the shell is clickable.
- Started M2 with Rust preset structs, JSON serialization tests, preset CRUD commands, and a Presets page that can create/list/delete a starter preset.

**What remains:**
- Full preset editor UI.
- Import/export UI wiring.
- Better validation and duplicate-name handling.
- Commit once Git author identity is configured.

**Decisions and deviations:**
- Folder nodes now include an optional `role` field so later routing can target folder roles instead of fragile folder names.
- Preset files are stored by sanitized preset id for now; display names remain user-facing.

**Notes for next session:**
- Continue M2 by improving the Presets page into a real list/editor entry point, then move into M3 token resolution.

### 2026-04-24 M2 Continued

**Date:** 2026-04-24
**Milestone:** M2
**Status:** In Progress
**What was done:**
- Added native Tauri dialog plugin for preset import/export file pickers.
- Added checked-in example presets in `examples/`.
- Expanded the Presets page into a two-pane library/detail view.
- Added import, export, refresh, create starter, select, inspect, and delete actions.
- Added folder/variable/pattern summary UI for selected presets.
- Rebuilt and launched the desktop app.

**What remains:**
- Decide whether M2 should include a minimal edit form or defer all editing to M4 as originally planned.
- Add more validation around duplicate ids/names and malformed imported presets.
- Commit once Git author identity is configured.

**Decisions and deviations:**
- Added `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` at aligned version `2.7.0` because native import/export is needed repeatedly later.
- Kept full preset editing deferred for now to avoid stealing scope from M4.

**Notes for next session:**
- Finish M2 hardening, then start M3 Rust token resolver.

### 2026-04-24 Compact Preset Direction

**Date:** 2026-04-24
**Milestone:** M2 design refinement
**Status:** Complete
**What was done:**
- Updated the preset library/detail UI to use a denser PostHaste-inspired layout.
- Replaced large detail cards with compact tabs, tables, and tree rows.
- Added compact authoring guidance to `DESIGN_DIRECTION.md`.
- Rebuilt and launched the desktop app for review.

**What remains:**
- Apply the same compact pattern to the full M4 preset editor and M5 folder tree editor.
- Add actual inline editing once the M3 token system exists.

**Decisions and deviations:**
- Preset authoring should feel like a desktop utility control surface, not a dashboard.
- Use the current brand shell and rounded panels, but shrink inner padding and row heights for workflow-heavy screens.

**Notes for next session:**
- Continue M2 hardening or proceed to M3 token resolver once the compact direction feels right.

### 2026-04-24 M2 Hardening / M3 Start

**Date:** 2026-04-24
**Milestone:** M2 wrap-up / M3 start
**Status:** In Progress
**What was done:**
- Added duplicate preset support in Rust and the Presets UI.
- Changed imported presets to avoid silently overwriting an existing local preset with the same id.
- Added stronger preset validation for duplicate variable ids, duplicate folder ids, empty folder names, and missing footage destinations.
- Added the first Rust token resolver with support for global tokens, preset variables, per-clip tokens, folder context, date parts, clip padding, and Windows-safe sanitization.
- Added `preview_pattern` Tauri command and token resolver tests.
- Added compact pattern previews to the Presets Setup tab.
- Rebuilt and launched the desktop app.

**What remains:**
- Build the full M3 token input UI with token chips, scope filtering, slash autocomplete, and editable patterns.
- Decide final unresolved-token behavior for production ingest versus UI previews.
- Continue applying the compact desktop-utility treatment to authoring screens.

**Decisions and deviations:**
- Token preview now resolves through Rust, not a separate frontend-only approximation.
- Duplicate/import behavior protects local preset files by generating a unique id when needed.

**Notes for next session:**
- Continue M3 with the token picker and pattern input components.

### 2026-04-24 M3 Pattern Input Start

**Date:** 2026-04-24
**Milestone:** M3
**Status:** In Progress
**What was done:**
- Added frontend token metadata and pattern parsing helpers.
- Added a compact `PatternInput` component with editable pattern text, token insertion buttons, pill-style pattern rendering, and Rust-backed live preview.
- Wired `PatternInput` into the Presets Setup tab for root folder and file rename patterns.
- Scoped token choices so folder patterns show global/variable tokens and filename patterns also show clip/folder-context tokens.
- Rebuilt and launched the desktop app.

**What remains:**
- Add slash autocomplete.
- Support deleting/reordering tokens as first-class pill interactions.
- Move from preview-only edits to saved preset editing in M4.
- Add frontend tests once a test runner is introduced.

**Decisions and deviations:**
- Pattern edits in the Presets detail panel are preview-only for now, keeping M4 as the real preset editor milestone.

**Notes for next session:**
- Continue M3 UI polish with autocomplete and stronger token affordances.

### 2026-04-24 M3 Slash Autocomplete

**Date:** 2026-04-24
**Milestone:** M3
**Status:** In Progress
**What was done:**
- Added slash autocomplete to `PatternInput`.
- Typing `/` in a pattern field opens a filtered token menu.
- Arrow keys move through token matches; Enter/Tab inserts; Escape closes.
- Added the date-format setting requirement to M14 Settings.
- Rebuilt and launched the desktop app.

**What remains:**
- Add true pill deletion/reordering behavior.
- Build saved parameter customization in M4.
- Add global date format setting in Settings and thread it into Rust token resolution.

**Decisions and deviations:**
- Parameter customization remains M4, because it needs saved preset editing rather than preview-only controls.
- `{date}` should use a global settings-controlled default format in v1.

**Notes for next session:**
- Finish M3 token input polish, then transition to M4 compact preset editor.

### 2026-04-24 M3 Token Pill Deletion

**Date:** 2026-04-24
**Milestone:** M3
**Status:** In Progress
**What was done:**
- Added source ranges to parsed pattern parts.
- Token pills in `PatternInput` can now remove the whole token with one click.
- Rebuilt and launched the desktop app.

**What remains:**
- Decide whether reordering tokens should be drag-and-drop, arrow buttons, or left as text-field editing for v1.
- Transition to M4 for saved preset/parameter customization.

**Decisions and deviations:**
- Token pill deletion edits the underlying stored pattern string, preserving the portable `{token_id}` storage format.

**Notes for next session:**
- Start M4 compact preset editor with parameter customization.

### 2026-04-24 M4 Preset Editor Start

**Date:** 2026-04-24
**Milestone:** M4
**Status:** In Progress
**What was done:**
- Added a compact `PresetEditor` component.
- Added New/Edit/Save/Cancel flow from the Presets page.
- Added editable identity fields: name, description, color, primary destination, clip padding.
- Added editable parameter table with name, token id, type, default/options, required, add, and remove.
- Wired `PatternInput` into saved root folder and file rename pattern fields.
- Added native folder picker for primary destination.
- Added a blank preset factory for new presets.
- Rebuilt and launched the desktop app.

**What remains:**
- Add unsaved-changes warning.
- Improve parameter row details such as date defaults, dropdown default choice, reorder controls, and optional path-use flags if we decide to add them.
- Add secondary destination editing.
- Keep folder tree editing for M5.

**Decisions and deviations:**
- The editor uses a dense table layout inspired by PostHaste preferences while preserving the rounded Ingest Pilot shell.
- The folder tree remains read-only/placeholder in M4 to keep M5 focused.

**Notes for next session:**
- Harden M4 editor interactions, then prepare M5 folder tree editing.

### 2026-04-24 M4 Editor Refinements

**Date:** 2026-04-24
**Milestone:** M4
**Status:** In Progress
**What was done:**
- Added a color picker swatch next to the preset color hex field.
- Reworked clip padding into `Clip # Padding` with +/- stepper controls.
- Added a tooltip and inline example showing how padding affects `{clip#}`.
- Added a compact read-only Global Parameters panel in the editor.
- Documented that team-wide custom global parameters should live in Settings later, while preset-specific parameters stay in the preset editor.
- Rebuilt and launched the desktop app.

**What remains:**
- Add Settings support for user-defined global parameters and the default `{date}` format.
- Add unsaved-changes warning and secondary destinations.
- Continue hardening the parameter table before M5.

**Decisions and deviations:**
- Built-in/global tokens are visible in the editor as read-only reference chips.
- User-created global parameters should be managed in Settings rather than inside every preset.

**Notes for next session:**
- Continue M4 hardening, then move toward M5 folder tree editing.

### 2026-04-24 Date Format Note

**Date:** 2026-04-24
**Milestone:** M3 / Settings follow-up
**Status:** Noted
**What was done:**
- Captured the product decision that `{date}` should eventually use a configurable default date format.

**What remains:**
- Add the date format control in Settings.
- Thread the selected date format into token preview, folder scaffolding, and ingest rename resolution.

**Decisions and deviations:**
- Prefer a global/default date format setting for v1 over per-token modifiers like `{date:YYYY-MM-DD}`.

**Notes for next session:**
- Continue M3 token input polish; implement the actual date format setting later with Settings.

### 2026-04-24 M5 Folder Tree Editor Start

**Date:** 2026-04-24
**Milestone:** M5 Session 1
**Status:** In Progress
**What was done:**
- Added a compact `FolderTreeEditor` inside the saved preset editor.
- Reworked the editor into a PostHaste-inspired visual folder tree with folder icons, dotted hierarchy guides, selection, and a compact inspector.
- Added editable tokenized folder name patterns using the compact `PatternInput` in the inspector.
- Added root folder creation, subfolder creation, duplicate, delete, move up/down, indent, and outdent controls.
- Added expand/collapse behavior and clearer parent/child hierarchy.
- Added role selection and footage target marking, with a safety helper to keep a footage target when folders exist.
- Added native Tauri drag-and-drop import for existing folder structures from disk; dropping a template root folder imports its child folders, with an overwrite-or-append prompt when the preset already has folders.
- Added the Rust `import_folder_tree` command so folder import reads real filesystem paths provided by the OS rather than relying on browser-only drag data.
- Changed folder import to include the dropped root folder as the imported top-level node.
- Replaced the ambiguous OK/Cancel import prompt with an in-app Add / Replace dialog.
- Restored role-colored folder icons and added `Footage` as a selectable folder role while keeping `Set Target` as the separate destination marker.
- Set the default `Folder` role to use a familiar amber folder color.
- Added internal pointer-based drag rearranging in the folder editor, supporting before, inside, and after drop positions without relying on browser HTML drag/drop.
- Increased the default desktop window from 1200x780 to 1440x900, with a 1100x700 minimum.
- Made the main sidebar collapse to an icon rail below very wide desktop widths so compact windows keep more room for the preset editor.
- Tightened Presets page spacing at smaller widths and added safe horizontal overflow for dense parameter tables.
- Simplified folder icon color so meaning comes from selection and target badges rather than loud role colors.
- Kept list parameters focused on option definitions in the parameter table, and moved dropdown token value selection into the folder inspector so a folder using `{campus}` can preview as `KLR`, `FM`, etc. without changing the global parameter definition.
- Added reusable folder-tree manipulation helpers in `src/lib/folderTree.ts`.
- Rebuilt the frontend and reran Rust tests.

**What remains:**
- Add true drag-and-drop handles inside the tree if the button-based nesting controls feel too slow.
- Add conditional folder editing and template file support in M5 Session 2.
- In M6, the create-folders/ingest form should prompt for unresolved parameters and can reuse folder-level preview selections as suggested starting values.
- Add dedicated frontend unit tests once a TypeScript test runner is introduced.

**Decisions and deviations:**
- Built M5 Session 1 without a drag-and-drop dependency; compact button controls give us the core tree UX immediately and avoid dependency churn.
- Folder names use the same slash-token behavior as root and rename patterns, but the tree itself now prioritizes visual clarity over spreadsheet-style density.

**Notes for next session:**
- Exercise the folder editor in the app, then move into conditional folders and template files.

### 2026-04-24 M5 Compact UX Follow-up

**Date:** 2026-04-24
**Milestone:** M5 Session 1 refinement
**Status:** In Progress
**What was done:**
- Added clearer root-folder creation in the folder editor even when another folder is selected.
- Added a Clear selection action and blank-area click behavior so users can unselect a folder before adding roots.
- Made compact folder name pattern fields show token insertion buttons, while keeping slash autocomplete available.
- Restored the main navigation to be open at normal/default window sizes, with a dock toggle and icon-only behavior on smaller windows.
- Added a collapsible local preset library rail so the editor can reclaim horizontal space when needed.
- Added compact conditional folder controls in the folder inspector: always create, create if a parameter has a value, or create if a parameter equals a value.
- Added folder template file attachment UI with per-file rename-from-folder toggles.
- Added tree badges for conditional folders and folders with attached template files.
- Added a Rust condition evaluator with tests so M6 scaffolding can skip folders based on saved rules.
- Removed the always-visible Global Parameters card from the preset editor to reclaim vertical space.
- Tightened pattern editing in the preset editor by switching root/file rename patterns to compact inputs.
- Changed the preset detail Setup tab from preview-only editable controls to read-only pattern summaries with resolved previews, so view mode no longer looks partly editable.
- Made attached template files visible as child rows inside the visual folder tree, similar to Post Haste's folder/file hierarchy.
- Simplified the preset detail Setup tab to show only resolved example outputs plus saved destination/sidecar settings.
- Added a Sidecars toggle in the preset editor to preserve or ignore XML/paired sidecar files.
- Changed the Sidecars control to a visible checkbox row after feedback that the switch looked like plain text.
- Added targeted native drop handling for template files: dropping files onto a folder row attaches them to that specific folder.
- Dropping folder structures onto a folder row now imports them as children of that folder; dropping on empty tree space still uses the add/replace structure import flow.
- Added a Rust `inspect_template_drop` command to classify dropped paths as files or folders before the UI decides how to attach them.
- Replaced the broad full-tree drop overlay with row-level `Drop here` feedback when a specific folder is targeted.
- Simplified the folder inspector by removing duplicate action buttons; move/reorder now relies on the visual tree controls, while the inspector focuses on folder properties.
- Combined preset Setup/Folders/Routing tabs into one preset overview with example outputs, folder structure, and routing summary visible together.
- Reworked the preset overview folder structure from a text/table list into a condensed visual tree with folder/file icons plus role, condition, and target badges.
- Moved routing summary to the top-right of the preset overview, with the visual folder tree spanning the lower section.
- Inverted the sidecar editor control: unchecked now means sidecars are kept by default, while checking it means XML/paired sidecar files should be deleted.

**What remains:**
- Add persistent preset library folders/collections so local presets can be organized into named, user-customizable groups.
- Wire conditional folder evaluation and template file copying into the M6 scaffolding engine.

**Decisions and deviations:**
- Preset library folders should be persisted in app data or preset metadata rather than faked as a temporary UI-only grouping.
- Compact pattern fields should expose both visible token buttons and `/` autocomplete so users do not have to memorize token IDs.
- Conditional folder controls belong directly in the folder inspector rather than a separate rules page.
- Preset detail is now inspect-only; saved changes happen through Edit to avoid mixed editing behavior.

**Notes for next session:**
- Move into M6: resolve the root pattern and folder tree, evaluate folder conditions, create folders on disk, and copy attached template files.

### 2026-04-27 M5 Template File Refinement

**Date:** 2026-04-27
**Milestone:** M5 Session 2 refinement
**Status:** In Progress
**What was done:**
- Promoted dropped template files into clickable items inside the visual folder tree.
- Added pointer-drag movement for template files so attached files can be moved from one folder row to another.
- Added per-template-file rename patterns with the same tokenized filename editor used elsewhere.
- Added quick choices for template files: keep the original filename or rename from the destination folder name.
- Removed the separate Template Files section from Folder Details so the tree remains the source of truth.
- Updated the preset overview tree to show each attached file's saved rename pattern.
- Extended the preset schema with optional `template_files[].rename_pattern` while preserving the existing `name_from_folder` compatibility flag.
- Rebuilt the frontend and reran Rust tests.

**What remains:**
- In M6, use each template file's `rename_pattern` when copying starter files into the generated folder tree.
- Consider file-to-file reordering inside a single folder if order becomes useful beyond visual organization.

**Decisions and deviations:**
- Newly dropped files default to `{folder_name}{ext}` because this matches the “rename from folder” workflow, while `{original_name}{ext}` remains one click away.
- File editing now happens by selecting the file row, rather than by managing a secondary list in the folder inspector.

### 2026-04-27 M6 Scaffold Start

**Date:** 2026-04-27
**Milestone:** M6
**Status:** In Progress
**What was done:**
- Added a visible drag preview for folder and template-file movement inside the folder tree editor.
- Renamed folder/file pattern labels in the inspector to `Name` and added hover help explaining token use.
- Simplified the preset overview folder tree by removing folder role text badges.
- Replaced detailed conditional labels like `{campus} has value` with a simpler `Conditional` badge.
- Renamed the Scaffold navigation/page language to `New Project` so the action reads like a user workflow rather than developer terminology.
- Removed target/conditional badges from the preset viewer folder tree; those details remain in the editor where they are actionable.
- Added a Project Folder Preview on the New Project page so users can see the resolved root folder name before creating folders.
- Changed dropdown-style parameter fields on New Project into typed fields with suggestions so comma-separated values like `KLR, MCK` can be entered.
- Added a Rust folder scaffolding engine that resolves the root pattern and folder tree, evaluates folder conditions, creates folders on disk, and copies attached template files.
- Added comma-separated folder-token expansion: a folder named `{campus}` with `KLR, MCK` creates one branch for `KLR` and one for `MCK`, including child folders/template files under each branch.
- Added per-template-file rename pattern support during scaffold copying.
- Added the `scaffold_project` Tauri command.
- Added a functional Scaffold page with preset selection, variable entry, destination picker, Create Folders action, and result summary.
- Added Rust tests for conditioned folder creation, template-file copying, and comma-separated folder token expansion.

**What remains:**
- Add a folder preview before creating folders so users can inspect the resolved tree before writing to disk.
- Decide overwrite/conflict behavior for existing template files.
- Expand this into the New Ingest flow in M7 by adding source scanning and routed file copy.

**Decisions and deviations:**
- M6 now lives under the dedicated Scaffold navigation item as a clean PostHaste-style workflow before full ingest comes online.
- For now, the backend fills missing values from preset defaults and blocks only required parameters that remain blank.

### 2026-04-27 M7 Scan Start

**Date:** 2026-04-27
**Milestone:** M7 Session 1
**Status:** In Progress
**What was done:**
- Added automatic File Explorer opening after a New Project folder is created.
- Added a cross-platform `open_path` Tauri command for opening created folders.
- Added a Rust source scanner that recursively inventories a selected source folder.
- Added extension summaries with file counts and total bytes.
- Added the `scan_source` Tauri command.
- Replaced the New Ingest placeholder with a functional scan-first screen: source picker, Scan Source action, total file/size summary, and extension breakdown.
- Replaced typed comma entry for list parameters on New Project with a compact checkbox dropdown that stores selected values as comma-separated branches.
- Added a Rust test for recursive source scanning, extension normalization, and total size calculation.

**What remains:**
- Connect New Ingest to preset selection and New Project creation.
- Add file routing preview so scanned extensions show where they will land.
- Add the first non-verified copy/rename pass before M8 hashing.

**Decisions and deviations:**
- M7 starts with scan-only inventory so we can validate source detection before writing copied media.

### 2026-04-27 Global Parameters

**Date:** 2026-04-27
**Milestone:** Settings / shared authoring
**Status:** In Progress
**What was done:**
- Added a real Settings page with a Global Parameters editor.
- Global parameters support the same core types as preset parameters, including List options like `KLR, MCK, HLT, AGL`.
- Fixed list option text entry so commas/trailing separators can be typed naturally before the field normalizes on blur.
- Added Rust settings persistence in `Documents/IngestPilot/settings.json`.
- Added `get_settings` and `save_settings` Tauri commands.
- Threaded global parameters into preset pattern token pickers and folder-tree token previews.
- Threaded global parameters into New Project parameter entry, including checkbox dropdowns for global List parameters.
- Added a local-overrides-global rule: if a preset defines the same token as a global parameter, the preset-specific parameter wins.

**What remains:**
- Add date format settings alongside global parameters.
- Consider marking global tokens visually in token menus so they are distinguishable from preset-local tokens.

**Decisions and deviations:**
- Global parameters are settings-level reusable inputs; they are not copied into each preset file.

### 2026-04-27 M7 Routing Preview

**Date:** 2026-04-27
**Milestone:** M7 Session 1
**Status:** In Progress
**What was done:**
- Extended New Ingest from scan-only into a preset-aware workflow.
- Added preset selection to New Ingest.
- Added global + preset parameter entry to New Ingest, using the same checkbox dropdown behavior for list parameters.
- Added routing preview after source scan: each scanned extension shows file count, total size, and the current destination folder.
- Routing preview uses preset-specific file routing overrides first, then falls back to folder roles/footage target.

**What remains:**
- Move routing preview logic into Rust so the UI and copy engine share one authoritative routing path.
- Add the first non-verified copy/rename operation and progress state.

### 2026-04-27 M7 Manual Ingest Pass

**Date:** 2026-04-27
**Milestone:** M7 Session 1/2
**Status:** In Progress
**What was done:**
- Upgraded the scanner from extension-only counts into typed inventory: footage, photos, audio, documents, sidecars, unknown, and ignored files.
- Added sidecar pairing for XML/XMP/THM/CPF files that share a stem with a media/document file in the same folder.
- Added system/cache ignores for common junk files and folders like `.DS_Store`, `Thumbs.db`, `desktop.ini`, `__MACOSX`, and `.Trashes`.
- Added destination selection, Delete Sidecars control, Start Ingest action, and an ingest result summary to New Ingest.
- Added the first non-verified copy engine: scaffold project root/folders, route files by preset override or folder role, apply rename patterns, suffix duplicate filenames, and open the completed folder.
- Preserved paired sidecars beside renamed parent media when sidecars are kept.
- Added Rust coverage for typed scanning and copied media + paired sidecar behavior.
- Added near-term camera-card detection in New Ingest: while the page is open, the app polls drive roots for common camera structures like `DCIM`, `PRIVATE`, `M4ROOT`, `AVCHD`, `XDROOT`, `CONTENTS`, and `BPAV`.
- New Ingest auto-fills Source Folder from a detected camera card when the field is blank, or offers a compact Use button when another source is already selected.
- Thumbnail/preview folders are now scanned as filtered items instead of copyable media, so card-generated thumbnail `.jpg` files do not get routed as Photos during ingest.
- New Ingest now shows an Output Preview for the resolved project folder, target folder, and sample renamed file using the selected preset, current parameter values, and the first scanned routable file when available.

**What remains:**
- Replace the simple completion summary with live progress per current file / byte count.
- Move file-type categories and extension lists into editable global settings.
- Decide how multi-value folder parameters should route actual copied media when multiple branches exist.
- Later tray app milestone: background card detection and opening an ingest dialog even when the main app window is not visible.
- Reporting milestone: reuse filtered thumbnail references to show small visual previews in ingest reports.
- M8 will add checksum verification, MHL, and ingest reports.

### 2026-04-27 M8 Verification Start

**Date:** 2026-04-27
**Milestone:** M8
**Status:** In Progress
**What was done:**
- Added the first verification pass to manual ingest: every copied file is hashed after copy and compared with the source.
- Added one automatic retry when a copied file's verification hash does not match.
- Added verification counts to the ingest result: copied, verified, failed, skipped, and copied size.
- Added Rust tests for deterministic file hashing, copy verification, and verified ingest copies.
- Cleaned up New Ingest layout so Setup stays left, Parameters and Output Preview share the top-right area, and Inventory & Routing sits below them.

**What remains:**
- Swap the temporary internal stable 128-bit hash to the planned XXH3-128 implementation once dependency fetching/build approvals are available.
- Add MHL generation and the human-readable ingest report.
- Add report-opening UI and persist verification details to disk.

### 2026-04-27 Ingest Control Pass

**Date:** 2026-04-27
**Milestone:** M7/M8 bridge
**Status:** Complete
**What was done:**
- Added cancellable ingest jobs with a Cancel Ingest button on the New Ingest screen.
- Added a Rename Files toggle on New Ingest so users can either apply the preset rename pattern or keep original source filenames.
- Made renamed copies preserve their original extension even when the preset rename pattern omits `{ext}`.
- Kept the source scan in place when parameter values change, so switching Campus/options refreshes previews and routing without forcing another scan.
- Updated footage routing to prefer the deepest matching footage/target folder, so a selected token folder like `Footage/{campus}` receives media instead of the base `Footage` folder.
- Added Rust coverage for extension preservation and token child-folder routing.

**What remains:**
- Add true live byte/file progress while a long ingest is running.
- Move the UI routing preview to the same backend resolver used by the copy engine so every row shows the exact resolved destination.

### 2026-04-27 M8 Report Output

**Date:** 2026-04-27
**Milestone:** M8
**Status:** In Progress
**What was done:**
- Added first-pass MHL output after successful ingest at `IngestPilot.mhl` in the project root.
- Added first-pass human-readable HTML ingest report at `IngestPilot_Report.html` in the project root.
- Reports include preset name, source, destination, parameters, copied file list, hashes, verification status, skipped files, and summary counts.
- Added `mhl_path` and `report_path` to the ingest result returned to the UI.
- Added an Open report action to the New Ingest result panel.
- Added Rust tests for MHL writing, HTML report writing, and full ingest report/MHL creation.

**What remains:**
- Replace the temporary `stable-128` hash label/implementation with planned XXH3-128 when dependency fetching is available.
- Polish report visual design and add thumbnail previews later in the reporting milestone.
- Persist report metadata into the History page.

### 2026-04-27 Ingest Manifest and Progress

**Date:** 2026-04-27
**Milestone:** M8
**Status:** In Progress
**What was done:**
- Added a Files to Copy manifest on New Ingest after scanning.
- Media/document rows are selectable with checkboxes, including All/None controls for partial-card ingest.
- Paired sidecars show in the manifest as automatic rows tied to their selected parent media unless Delete sidecars is enabled.
- Threaded selected relative paths into the Rust copy engine so only selected media/doc files are copied.
- Added Tauri `ingest-progress` events and an Ingest Progress panel with phase, current file, file counts, and copied bytes.
- Added backend coverage that selected-copy ingest skips unselected media.
- Moved file selection into a large modal opened by Choose files so New Ingest stays less crowded.
- When Delete Sidecars is enabled, sidecars are hidden from the file selector rather than shown as skipped rows.
- Included sidecars now show as simple checked companion rows.

**What remains:**
- Make progress byte-level during a single very large file copy; the current first pass updates between copied files and report phases.
- Move the manifest routing preview to the backend resolver so each row can show its exact destination path before ingest.

### 2026-04-27 Ingest Run Screen and Report Thumbnails

**Date:** 2026-04-27
**Milestone:** M8
**Status:** In Progress
**What was done:**
- Moved the blocking ingest command onto a Tauri blocking worker so the app shell stays responsive during copy/verify/report work.
- Added a dedicated full-screen ingest run view once copying starts.
- The run view includes transfer speed, estimated remaining time, elapsed time, copied bytes, file counts, a branded transfer graph, circular progress gauges, current file, and cancel.
- Extended progress events with elapsed milliseconds, bytes per second, and estimated remaining milliseconds.
- Added first-pass report thumbnails:
  - JPG/PNG/GIF/WebP photo copies display directly in the report.
  - Camera thumbnail/preview JPG/PNG files found in thumbnail/preview folders are matched by stem and copied into `IngestPilot_Report_Assets/thumbs` for video report rows.
- Updated the HTML report with a thumbnail/shot column and a more polished, readable visual treatment.
- Added Rust coverage for matching camera thumbnails into the report.

**What remains:**
- Add true video frame extraction later with an FFmpeg or media-framework integration for cards that do not include usable thumbnails.
- Add byte-level progress inside single huge file copies rather than between files only.

### 2026-04-27 Existing Folder Ingest Mode

**Date:** 2026-04-27
**Milestone:** M8/M9 prep
**Status:** Complete
**What was done:**
- Added a New Ingest destination mode toggle: Create new or Existing folder.
- Create new keeps the current behavior: destination is treated as a parent folder and the preset root pattern creates a new project root inside it.
- Existing folder treats the selected destination as the exact project root, skips the preset root-folder pattern, and routes media into the preset folder tree inside that existing folder.
- Existing-folder ingest creates missing routing folders as needed while preserving already-created folders.
- Output Preview now reflects the selected destination mode.
- Added Rust coverage proving existing-folder ingest does not create the preset root folder again.

**What remains:**
- Consider adding a confirmation when Existing folder points at a folder that does not appear to match the selected preset.

### 2026-04-27 Camera Token Heuristic Fix

**Date:** 2026-04-27
**Milestone:** M8 polish
**Status:** Complete
**What was done:**
- Fixed `{camera}` for Sony/FX-style card layouts where the parent folder is a generic `CLIP` folder.
- The ingest engine now prefers camera-like filename prefixes such as `FX3` from `FX3_6713.MP4`.
- Generic camera-card folder names like `CLIP`, `PRIVATE`, `M4ROOT`, `STREAM`, and `DCIM` are ignored as camera names.
- Output Preview uses the same frontend heuristic so previews match ingest output.
- Added Rust coverage for the FX3 filename-prefix case.

**What remains:**
- Longer term, add an explicit camera-name override in the ingest form for cards whose filenames do not contain a useful camera hint.

### 2026-04-27 Compact Ingest View and Thumbnail Matching

**Date:** 2026-04-27
**Milestone:** M8 polish
**Status:** Complete
**What was done:**
- Briefly tested a Basic / Advanced split, then removed it based on feedback.
- Kept all New Ingest controls visible and tightened the layout instead.
- Reduced setup padding, option row heights, summary padding, and routing table column widths so the page stays compact without hiding functionality.
- Broadened report thumbnail matching beyond exact stems:
  - Recognizes `THMBNL` and `.thumbnails` folders.
  - Matches camera thumbnails by exact stem, normalized stem containment, clip digits, and a deterministic fallback when a camera card supplies thumbnails without matching names.
- Added Rust coverage for Sony-style `PRIVATE/M4ROOT/THMBNL` thumbnail matching.

**What remains:**
- Add true video frame extraction later for cards that do not include usable still thumbnails.

### 2026-04-27 ShotPut-Inspired Ingest Simplification

**Date:** 2026-04-27
**Milestone:** M8 hardening
**Status:** In Progress
**What was done:**
- Reworked New Ingest toward a ShotPut-style main surface:
  - Large Copy From and Copy To zones are now the primary interaction.
  - Scan and Start remain visible on the main surface.
  - Preset summary, output preview, selected files, and last ingest live in a compact right rail.
  - Detailed options moved behind a cog-style Ingest Settings panel.
- The settings panel contains preset selection, destination mode, sidecar deletion, rename behavior, parameters, and routing diagnostics.
- Improved the generated HTML report with a cleaner job header, verification status pill, summary tiles, and per-file cards with thumbnails, paths, sizes, hashes, and source references.
- Made the checksum/report wording explicit that the current verification hash is the MVP stable-128 implementation.

**What remains:**
- Replace the MVP stable-128 verification hash with the planned production checksum/hash implementation.
- Add richer report export options and true video thumbnail extraction.

### 2026-04-27 Multi-Source Ingest First Pass

**Date:** 2026-04-27
**Milestone:** M8/M9 prep
**Status:** In Progress
**What was done:**
- Changed source picking on New Ingest to allow selecting multiple folders/cards at once.
- New Ingest now tracks multiple source paths and scans each selected source.
- Changed the source picker from unreliable multi-folder native selection to a sturdier Pick / Add-source flow, with removable source chips.
- Combined scan summaries feed the main source totals, file selection dialog, routing preview, and output preview.
- File selection keys are source-aware so duplicate relative filenames across cards do not collide in the UI.
- Start Ingest now copies selected files from each scanned source into the same project/destination:
  - The first source creates or uses the project root.
  - Later sources ingest into that same root as an existing project folder.
- The main Copy From zone now displays the number of selected sources and a compact source-name list.

**What remains:**
- Generate a single consolidated multi-source report/MHL instead of the current sequential-source report behavior.
- Add aggregate progress across all selected sources rather than resetting progress per source.
- Add a clearer multi-source source list with remove/reorder actions if the simple picker feels too opaque.

### 2026-04-27 Compact Ingest Layout Return and M9 Start

**Date:** 2026-04-27
**Milestone:** M8 hardening / M9 start
**Status:** In Progress
**What was done:**
- Returned New Ingest to the compact control-surface layout:
  - Setup and copy controls on the left.
  - Parameters, output preview, file summary, ingest result, and routing preview on the right.
  - Removed the cogwheel/settings-panel split from the main ingest workflow.
- Kept multi-source selection from the prior pass, shown as compact source chips in Setup.
- Started M9 multi-destination copy:
  - Added backup destination rows below the primary destination.
- Start Ingest now copies each selected source to each selected destination.
- The first source creates or uses each destination root; later sources ingest into that same root.
- Each destination copy is independently verified by the existing ingest engine.
- Added a backend `write_ingest_report` command so multi-source/multi-destination runs can write a combined HTML job report from merged copied/skipped file results.

**What remains:**
- Consolidate multi-destination MHL files into one job-level MHL.
- Add aggregate progress across sources and destinations.
- Add a stronger destination status/result list so each destination has its own pass/fail summary.

### 2026-04-28 Packaged App Visibility Fix

**Date:** 2026-04-28
**Milestone:** App stability
**Status:** Complete
**What was done:**
- Fixed the blank packaged-app shell by setting Vite `base: "./"` so built JS/CSS assets are referenced with relative paths in `dist/index.html`.
- Rebuilt the frontend and confirmed `dist/index.html` now points to `./assets/...`.
- Built a fresh packaged release in `src-tauri/target-visible` to avoid a stale Windows lock on the older release executable.

**What remains:**
- Track down and clear the old Windows file lock on `src-tauri/target/release/ingest-pilot.exe` when convenient.

### 2026-05-08 Production Tool Density Pass

**Date:** 2026-05-08
**Milestone:** UI hardening
**Status:** In Progress
**What was done:**
- Shifted the visual direction toward a tighter production utility surface inspired by Post Haste and classic desktop render dialogs.
- Reduced large outer padding, softened but flattened panel chrome, and replaced heavy dashboard spacing with compact rows.
- Tightened the sidebar, Home, Presets, New Project, Settings, Preset Editor, Folder Tree Editor, and ingest progress surfaces.
- Kept the existing brand colors and rounded feel, but reduced large-card real estate so functional controls and previews sit closer together.

**What remains:**
- Continue converting high-use workflows to denser table/tree layouts.
- Audit the New Ingest screen with real cards and reports after the next ingest-engine pass.
- Decide which “nice-looking” panels should become simpler utility sections as the app stabilizes.
