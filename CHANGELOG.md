# Changelog

All notable changes to Ingest Pilot are documented here. This file also feeds the
in-app **What's new** popup: when you push a version tag, CI extracts the section
matching that tag (e.g. `v0.1.4` → the `## [0.1.4]` section) and uses it as the
GitHub Release notes, which the updater then shows inside the app.

Format based on [Keep a Changelog](https://keepachangelog.com). Keep entries short
and user-facing — this is what people read in the update popup.

## [Unreleased]

## [0.1.5]

### Added
- **Year-aware destinations.** A preset can now point at a stable parent folder (e.g.
  …/Videos) and auto-descend into a tokenized sub-path each ingest — for example
  `{year}/Broll` lands in …/Videos/2026/Broll. If those folders already exist the
  ingest joins them; otherwise they're created. Set it under a preset's
  **Sub-folder path**. (Removes the yearly preset rework and lets a second campus
  drop into an event already imported.)
- **Naming tab.** The Naming Assistant now has its own left-sidebar tab. Pick a
  deliverable, fill a field or two, and it builds the SOP-correct name and saves it
  as its own preset file in Documents. The ministry codes, campuses, signifiers, and
  templates live in an editable catalog (`Documents/Ingest Pilot/Naming/catalog.json`)
  that syncs with your presets — this is where the naming sheet gets folded in.
- **Naming in the preset editor.** Apply a naming template to a preset to set its
  folder-name pattern and year-aware sub-path per the SOP in one click.
- **Per-folder metadata.** Attach a metadata preset to a specific folder (e.g. a
  campus folder) in the preset editor; clips that land there are tagged in the iconik
  CSV with that folder's metadata — so multiple campuses in one root each carry their
  own values in a single manifest.

## [0.1.4]

### Added
- **Auto-update.** Ingest Pilot now checks for a newer version on launch. When one
  is available it shows a **What's new** popup with the changes and, with your
  approval, downloads and installs the update, then restarts.
- **Settings → About & Updates.** A manual "Check for updates" button and the
  current app version.
- **Metadata presets (iconik).** Build reusable metadata schemas (categories +
  fields), attach one to a preset, fill it once per ingest, and export a CSV
  manifest for iconik. Manage schemas from the Metadata tab or in the preset editor.
- **Naming Assistant.** Pick a deliverable (e.g. Individual Baptism Story), fill a
  couple of fields, and it builds the SOP-correct project name and preset for you.
- **Queue mode & folder drag-and-drop**, a redesigned **Choose Files** dialog
  (click-header sorting, filters, Today/Yesterday grouping), **per-folder file-type
  routing**, **custom file types** (map extensions to a role globally), and a
  first-run step that captures your operator name.

### Changed
- **Preset library moved to `~/Documents/Ingest Pilot/`.** Each preset is its own
  named file (Presets / Metadata Presets subfolders) so it's visible in Finder and
  easy to sync across machines. Existing presets are migrated automatically.
- Tokens in name patterns are clickable pills, and a blank optional token drops its
  separator so names stay clean.

### Fixed
- Scanning a source you don't fully have access to (e.g. a server share) no longer
  fails the whole scan — unreadable items are skipped and reported.
- Ingest setup is kept when you switch tabs and come back.

## [0.1.3]

### Fixed
- App data is stored outside `~/Documents`, which stops the macOS privacy prompts
  on launch.

## [0.1.2]

### Added
- Cross-platform release pipeline producing macOS, Windows, and Linux installers.
- Queue mode and the rest of the v0.1.2 feature sprint.
