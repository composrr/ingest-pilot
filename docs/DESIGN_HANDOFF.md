# Ingest Pilot Design Handoff

## Project Location

This project lives at:

`C:\Users\jondr\Documents\Codex\2026-04-24\files-mentioned-by-the-user-architecture`

The app name currently used throughout the project is **Ingest Pilot**.

## Short Product Summary

Ingest Pilot is a desktop production utility for video and creative teams. It combines three workflows that are usually split across multiple apps:

1. **Project folder creation**, similar to Post Haste.
2. **Verified media ingest**, similar to ShotPut Pro, Hedge, or Silverstack.
3. **Token-based file renaming on import**, similar to Lightroom-style import naming but built for video production workflows.

The goal is not to make a flashy app. The goal is to make a compact, reliable, professional production tool that helps teams organize projects the same way every time, copy camera media safely, rename files consistently, and generate useful ingest reports.

## Target Users

Primary users are small to mid-sized production teams, in-house creative teams, church media teams, video departments, and freelance shooters who need repeatable organization without a full Hollywood DIT workflow.

The app should feel more like a production console or utility than a marketing-style SaaS dashboard. Dense, clear, fast, and obvious is better than spacious and decorative.

## Core User Problems

- Post Haste creates folder structures but does not ingest, verify, or rename media.
- ShotPut-style tools ingest and verify media but do not create custom project folder structures with rich naming logic.
- Creative teams often use multiple apps in sequence, which creates inconsistent folder names, inconsistent file names, missed sidecars, and unclear reports.
- A new user should understand the app quickly: choose a preset, choose where media comes from, choose where it goes, fill in job fields, review what will happen, then start ingest.

## Main Concepts

### Presets

A preset is a saved production workflow. It can define:

- Preset name, description, color, and identity.
- Root project folder pattern, such as `{date}_BaptismStory_{story_name}`.
- Folder tree to create inside the project.
- Which folders receive footage, audio, photos, documents, or other routed files.
- Template files to copy into the created folder structure.
- File rename pattern, such as `{folder_name}_{camera}_{clip#}`.
- Per-folder rename overrides.
- Preset variables, such as `Project Name`, `Shoot Date`, `Campus`, `Story Name`, or `Client`.
- Dropdown/list variables with options, such as `KLR, MCK, HLT`.
- Default destination path.
- Sidecar behavior.

### Job Fields / Tokens

Tokens are variables used in folder names and file names.

Common examples:

- `{date}`
- `{year}`
- `{month}`
- `{day}`
- `{preset_name}`
- `{project_name}`
- `{story_name}`
- `{campus}`
- `{camera}`
- `{clip#}`
- `{original_name}`
- `{capture_date}`
- `{ext}`
- `{folder_name}`

The user fills in job-specific values on the ingest screen. Those values should be easy to find, because they directly affect the folder names and file names.

### Folder Management

The app has a visual folder tree editor. It should feel similar in function to Post Haste, but modernized and more brand-consistent.

Current/future folder management expectations:

- Visual tree with nested folders.
- Add root folders and subfolders.
- Reorder folders.
- Drag and drop folders.
- Import an existing folder structure from the computer.
- Include the root folder when importing a structure.
- Add template files into folders, such as `.prproj`, `.aep`, `.drp`, `.txt`, `.docx`, `.pdf`, `.xlsx`, etc.
- Rename template files based on the folder name or token pattern.
- Mark folders by role, such as Footage, Audio, Photos, Docs, or Other.
- Use role colors/icons only when they clarify routing.
- Show a clear preview of what will be created.

### New Project / Folder Creation

This is the Post Haste-like workflow without media ingest.

The user selects a preset, fills in job fields, chooses a destination, and creates the folder structure on disk. The app can auto-open the created folder after creation.

Important UX need:

The user should see a preview of the folder structure before clicking Create. They should not only see what was created after the fact.

### Ingest Media

This is the verified copy workflow.

The user chooses:

- Preset.
- One or more source folders or camera cards.
- Destination folder or project root behavior.
- Job fields/tokens that affect naming.
- Copy behavior, such as rename files on/off and delete sidecars on/off.
- Which files to copy.

Then the app scans the source, routes eligible files, copies them, verifies them, generates MHL/checksum output, and builds a readable report.

## Current Ingest Capabilities

The app currently supports or is being built toward:

- Camera/source folder scanning.
- Auto-detection of camera card-like structures such as `DCIM`, `PRIVATE`, `M4ROOT`, `AVCHD`, `XDROOT`, `CONTENTS`, and `BPAV`.
- File classification into footage, photos, audio, documents, sidecars, ignored, or unknown.
- Filtering out camera thumbnail folders and unwanted generated files from normal copy.
- Sidecar pairing, such as XML, XMP, THM, CPF, etc. following matching media.
- Toggle to keep or delete sidecars.
- Toggle to rename files or keep original filenames.
- Multi-source selection is desired.
- Multi-destination copy is desired.
- Scan inventory showing selected count, total size, available destination space, and routing.
- File selector where users can choose only some files from a card.
- Sorting files by date captured/modified time, name, size, source path, etc.
- Thumbnail view for file selection is planned or partially prototyped.
- Thumbnail size should be adjustable with a slider.
- Shift-select should select rows without automatically checking/unchecking them.
- Start ingest should show live progress, copy speed, remaining amount, percent, and current phase.
- Ingest should remain responsive during copy and report generation.
- Cancel ingest should be possible.
- Reports/thumbnails should build in the background without slowing copy speed.

## Current Preview Needs

A major design requirement is that users need to understand what will happen before they click Start.

The ingest screen should include a preview area or tab showing:

- The project/root folder that will be created or used.
- The resolved folder structure with tokens filled in.
- Where each role routes, such as footage to `Footage/KLR`, audio to `Audio`, documents to `Docs`, etc.
- Sample selected files and their final destination paths.
- Sample renamed filenames.
- Sidecar behavior.
- Whether original filenames are being kept.

The preview should reduce fear and confusion. A new user should not need to understand the internal preset editor to know where files will land.

## Reports

The app should generate readable ingest reports inspired by ShotPut.

Reports should include:

- Job name / project folder name.
- Preset used.
- Source and destination paths.
- Start/end time.
- Duration and transfer stats.
- Files copied.
- File sizes.
- Verification hashes.
- Any verification failures.
- Sidecars deleted or skipped intentionally.
- MHL path.
- Human-readable HTML report.
- Thumbnails for media clips when possible.

Important reporting direction:

- Reports should not list every unselected file as "skipped." That creates noise.
- Reports should include true failures, copy errors, verification errors, and intentional sidecar deletion counts.
- Report names should be based on the resolved project folder/job name, not just the preset name.
- Thumbnail generation should not block the main ingest.

## Settings

Settings should eventually include:

- Global variables/tokens available across presets.
- Date format defaults.
- Ingest defaults, such as rename files by default, delete sidecars by default, open folder when done.
- Report defaults, such as include thumbnails, write HTML report, open report when done.
- File selector defaults, such as list/thumb view and thumbnail size.
- Camera watcher/tray behavior.
- File type routing defaults.
- Preset storage/sync behavior.

Currently, settings exist but need stronger information architecture so they do not feel like an afterthought.

## Current UX Problem

The app has powerful functions, but the UI can feel complex because too many decisions are visible at once and some related controls are separated.

The desired redesign should solve this:

- Make the app feel compact and professional.
- Keep advanced functionality available without making the first view feel intimidating.
- Put the most important job setup choices in the top/control area.
- Make job fields/tokens obvious because they affect naming.
- Make preview obvious because it builds trust.
- Make the Start Ingest action prominent.
- Make file selection feel like a real file browser/table, not text on a page.
- Make folder management feel like a direct visual tree.
- Avoid wasting screen space with large cards or decorative panels.
- Avoid hiding critical options too deeply.
- Make every page answer: "What is this for, what do I do next, and what will happen?"

## Suggested Screen Model For Redesign

### Ingest Screen

Recommended high-level layout:

1. **Top job bar**
   - Preset selector/search.
   - Copy From source(s).
   - Copy To destination(s).
   - Destination space.
   - Job fields/tokens.
   - Copy behavior: create new/use existing, rename files, delete sidecars.

2. **Main working area**
   - Tabs or panes for Files, Preview, Routing, Report.
   - Files: selectable scanned files, date captured, size, path, maybe thumbnail mode.
   - Preview: resolved folder structure and where files will land.
   - Routing: extension/category breakdown.
   - Report: after ingest.

3. **Right ready panel**
   - Project folder preview.
   - Sample final filename.
   - Selected count and total size.
   - Warnings and readiness state.

4. **Bottom action bar**
   - Start Ingest button.
   - Cancel during ingest.
   - Live progress, speed, amount copied, ETA.

### Presets Screen

Recommended layout:

- Left preset browser/search.
- Main preset detail/preview.
- Edit button opens dense editor.
- Preview mode should show examples, not raw pattern editing.
- Editor should expose identity, variables, root/folder/file naming patterns, folder tree, template files, routing/sidecar settings.

### New Project Screen

Recommended layout:

- Preset selector.
- Job fields.
- Destination.
- Folder preview.
- Create Project button.

This screen should feel like "make folders only" and be clearly different from "ingest media."

## Tone And Visual Direction

The preferred direction is a blend of:

- Post Haste density and clarity.
- ShotPut ingest/report confidence.
- A restrained modern desktop app feel.
- Production utility more than beautiful dashboard.

Useful qualities:

- Compact rows.
- Clear labels.
- Real tables where tables are appropriate.
- Small but readable inputs.
- Light borders and grouped sections.
- Minimal empty space.
- Context menus for deeper customization.
- Tooltips only where they clarify workflow.
- Strong, obvious primary action buttons.

Avoid:

- Overly large cards.
- Marketing-style hero layouts.
- Too much whitespace.
- Controls that look decorative instead of functional.
- Hiding core ingest decisions in obscure tabs.
- Making every option visible in a way that overwhelms the screen.

## Key Design Question For Claude

How can Ingest Pilot present a powerful ingest/folder/preset system in a way that feels immediately understandable to someone who has never used it?

The design should make the user think:

"I choose the preset, fill in the job fields, pick what I am copying from and to, preview exactly what will happen, and start a verified ingest."

