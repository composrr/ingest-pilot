# Changelog

All notable changes to Ingest Pilot are documented here. This file also feeds the
in-app **What's new** popup: when you push a version tag, CI extracts the section
matching that tag (e.g. `v0.1.4` -> the `## [0.1.4]` section) and uses it as the
GitHub Release notes, which the updater then shows inside the app.

Format based on [Keep a Changelog](https://keepachangelog.com). Keep entries short
and user-facing  -  this is what people read in the update popup.

## [Unreleased]

## [0.1.16]

### Added
- **Rename files right on the Ingest screen.** Under **Rename files** there's now a
  **File name** box — click **Change** to edit the filename pattern for this ingest
  (type `$` for tokens like `{camera}`, `{clip#}`, `{date}`, or your preset's
  variables). A live example shows the result, and **Reset to preset** puts it back.
  It only affects the current run; your preset is untouched.

### Fixed
- **Switching tabs no longer clears your setup.** Visiting Presets, Naming, or
  another tab and coming back to Ingest kept wiping the destination, metadata, and
  variable fields. Your in-progress setup now stays put.
- **"Requires 2 verified copies" with Safe Mode off.** Turning Safe Mode on raised
  the required-copies count but turning it off never lowered it, so ingests kept
  getting blocked. Safe Mode off now relaxes the whole group, and the warning names
  the exact Settings → Safety control instead of blaming Safe Mode.

## [0.1.14]

### Added
- **Choose your date format.** A new **Date format** setting (Settings → Ingest)
  controls how the `{date}` token renders in every naming pattern — pick
  `YYYY-MM-DD`, `MM-DD-YYYY`, `YYYY_MM_DD`, and more. Each choice shows a live
  example so you can see exactly what you'll get.
- **Search any naming-preset dropdown.** The "Apply a naming preset" picker (and
  other long dropdowns) now have a type-to-filter search box and list their
  entries alphabetically, so you can find a template without scrolling.

### Fixed
- **Edits in other tabs show up right away.** Renaming or editing a preset, or
  changing a setting, now updates the Ingest screen immediately instead of needing
  a manual refresh.

### Added
- **Search your naming templates.** A search box under the Templates header filters
  templates by name as you type (matching groups open automatically).

### Changed
- **Naming templates are alphabetical.** Templates inside Video Capture and Delivered
  Video are now sorted A-Z so they're easier to scan.
- **Signed & notarized Mac builds.** The macOS app is now code-signed with a Developer
  ID certificate and notarized by Apple, so it installs without the "unidentified
  developer" warning.

## [0.1.12]

### Added
- **Settings is now tabbed** (Ingest, Automation, Metadata, Reports, Safety, Advanced,
  About) with a **Show advanced** toggle that hides the power-user sections until you
  want them.
- **Choose where reports go.** Set the report, offload proof, reel index, and metadata
  CSV to land in the project folder, a subfolder (like `_Admin`, with `{year}` tokens),
  or one central folder, so your delivery folders stay clean. The verified MHL stays
  with the media unless you move it too. In Settings > Reports.
- **Data-safety guardrails** (Settings > Safety): a Safe Mode master switch, plus
  never-delete-source, require-N-verified-copies (blocks starting an ingest with too
  few destinations), a low-free-space hard stop, always-write-offload-proof, and
  confirm-before-risky-changes.
- **Sound controls** - turn the completion chime on/off, set its volume, and preview it.
- **Pop-open style** for card insert: always bring to front, only if already in front,
  or just notify without stealing focus.
- **Drive nicknames**, a **naming-token reference**, **keyboard shortcuts**
  (Ctrl/Cmd + 1-8 to switch views, Ctrl/Cmd + , for Settings), and a
  **Reset to defaults** button.
- **Backup & transfer your config** - export your whole setup (settings, presets,
  metadata presets, naming catalog, shooters) to one file and import it on another
  machine. iconik credentials are left out of the export.

### Changed
- Plainer wording throughout Settings ("Yes / No" instead of "Boolean", sidecars and
  tray explained), and turning on a file-removing option now asks first.

## [0.1.11]

### Added
- **Shooter metadata field.** A new "Shooter" field type records who shot the video.
  It defaults to whoever is running this copy of Ingest Pilot (your operator name),
  shows your internal staff by default, and has a toggle to reveal pre-loaded
  volunteers and contractors for big events. Add someone on the fly, or pre-load the
  full roster in Settings > Shooters. Add a matching field to your iconik view and it
  pushes with the rest of the metadata.

### Changed
- **Save now confirms.** Clicking Save in Settings turns the button green with a
  "Saved" check and a short confirmation banner, so it's clear the change took.

### Fixed
- **Metadata presets appear on Ingest right away.** A metadata preset you import or
  create in the Metadata tab now shows up on the Ingest screen immediately, instead of
  only after restarting the app.

## [0.1.10]

### Changed
- **History shows the project name.** Each job in the History list — and its detail
  panel — now shows the project/folder name the ingest created (for example the name
  you set in the Naming wizard) right under the preset name, so you can tell jobs
  apart at a glance instead of seeing only the preset.
- **The Ingest screen keeps your scan.** Switching presets or toggling a copy option
  no longer clears "Files to copy" and makes you press Rescan — your scan and file
  selection stay put, and sources rescan on their own when you add or remove one.

## [0.1.9]

### Added
- **Import metadata views from iconik.** In the Metadata tab, hit "iconik" to pull
  your metadata views straight from iconik and turn the ones you pick into metadata
  presets. Field names, types, and dropdown vocabularies come directly from iconik, so
  what you fill in at ingest matches iconik exactly and pushes land clean. Re-import a
  view any time to re-sync it.

## [0.1.8]

### Added
- **Runs in the background.** Closing the window now keeps Ingest Pilot alive in the
  system tray (Windows) or menu bar (Mac) so it can keep watching for cards. Open it
  again from the tray icon, or quit for real from there. Turn it off in Settings.
- **Pops open when you insert a card.** With the card watcher running in the
  background, plugging in a card brings the window to the front and jumps straight to
  Ingest with that card already selected and scanning.
- **Optional launch at login**, so the watcher is ready before you even open the app
  (Settings, Camera Cards & Background).
- **A sound when a transfer finishes** so you know it's done without watching the
  screen. A bright chime when everything verified, a lower tone when a file needs
  review.
- **iconik metadata push.** Connect your iconik instance in Settings and push shoot
  metadata straight onto assets after an ingest. No sidecar files, no CSV import.
  Assets are matched by filename.

### Changed
- The delivery screen now reads "Transfer complete."

## [0.1.7]

### Fixed
- **Windows auto-update.** The updater manifest was missing the Windows entry, so
  Windows couldn't self-update. Fixed, and the release now builds one platform at a
  time so the manifest always includes every platform.
- **Update notes no longer show garbled characters** (dashes and ellipses render
  correctly in the "What's new" popup).

### Changed
- The "What's new" update popup is larger, with a taller, scrollable notes area.

## [0.1.6]

### Added
- **Full naming system (tabs 3 & 4).** The Naming tab now carries every video naming
  template from the SOP  -  all the Capture folders (Weekends, Elevate, Growth Track,
  BOTS, Super Series, camps, seasonal events...) and Delivered Video folders (Baptism
  Stories, ONL, VAs, Promos / Impacts / Recaps / Title Packages). Grouped into a
  collapsible accordion with your own custom group names.
- **Name any ingest from a template.** In Ingest, the **Name** wizard lists every
  naming template; pick one to set the project name for that import  -  your selected
  preset (folders, routing, variables) stays exactly as chosen.
- **Auto-load memory cards.** Connect a card (SD, CFexpress, or a RED `.RDM`/`.RDC`
  card) and Ingest loads and scans it automatically  -  no clicks.
- **RED clips grouped.** In Choose Files, a RED clip's spanned `.R3D` segments now
  collapse into a single clip row you check or uncheck as one.
- **Type `$` for tokens.** In any name pattern or pre-folder field, type `$` to search
  and insert tokens (`$year` -> `{year}`).
- **Per-preset metadata tags.** A preset can pre-choose the metadata values it stamps
  on its imports (e.g. Content Type = Story) without editing the schema.
- **Copy time on the report.** The verification report now shows how long the copy
  and verify took.
- **New home screen**  -  quick actions and presets on the left, recent jobs on the right.

### Changed
- The Naming tab is a templates-first master/detail (like Metadata) with a hairline
  accordion; naming templates no longer clutter the Presets list.
- **Pre-folder path** (was "sub-folder path") now shows in the project-folder path
  preview on Create Folders, e.g. `.../Videos/2026/Broll/Project`.

## [0.1.5]

### Added
- **Year-aware destinations.** A preset can now point at a stable parent folder (e.g.
  .../Videos) and auto-descend into a tokenized sub-path each ingest  -  for example
  `{year}/Broll` lands in .../Videos/2026/Broll. If those folders already exist the
  ingest joins them; otherwise they're created. Set it under a preset's
  **Sub-folder path**. (Removes the yearly preset rework and lets a second campus
  drop into an event already imported.)
- **Naming tab.** The Naming Assistant now has its own left-sidebar tab. Pick a
  deliverable, fill a field or two, and it builds the SOP-correct name and saves it
  as its own preset file in Documents. The ministry codes, campuses, signifiers, and
  templates live in an editable catalog (`Documents/Ingest Pilot/Naming/catalog.json`)
  that syncs with your presets  -  this is where the naming sheet gets folded in.
- **Naming in the preset editor.** Apply a naming template to a preset to set its
  folder-name pattern and year-aware sub-path per the SOP in one click.
- **Per-folder metadata.** Attach a metadata preset to a specific folder (e.g. a
  campus folder) in the preset editor; clips that land there are tagged in the iconik
  CSV with that folder's metadata  -  so multiple campuses in one root each carry their
  own values in a single manifest.

## [0.1.4]

### Added
- **Auto-update.** Ingest Pilot now checks for a newer version on launch. When one
  is available it shows a **What's new** popup with the changes and, with your
  approval, downloads and installs the update, then restarts.
- **Settings -> About & Updates.** A manual "Check for updates" button and the
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
  fails the whole scan  -  unreadable items are skipped and reported.
- Ingest setup is kept when you switch tabs and come back.

## [0.1.3]

### Fixed
- App data is stored outside `~/Documents`, which stops the macOS privacy prompts
  on launch.

## [0.1.2]

### Added
- Cross-platform release pipeline producing macOS, Windows, and Linux installers.
- Queue mode and the rest of the v0.1.2 feature sprint.
