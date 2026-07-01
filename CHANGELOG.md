# Changelog

All notable changes to Ingest Pilot are documented here. This file also feeds the
in-app **What's new** popup: when you push a version tag, CI extracts the section
matching that tag (e.g. `v0.1.4` → the `## [0.1.4]` section) and uses it as the
GitHub Release notes, which the updater then shows inside the app.

Format based on [Keep a Changelog](https://keepachangelog.com). Keep entries short
and user-facing — this is what people read in the update popup.

## [Unreleased]

## [0.1.4]

### Added
- **Auto-update.** Ingest Pilot now checks for a newer version on launch. When one
  is available it shows a **What's new** popup with the changes and, with your
  approval, downloads and installs the update, then restarts.
- **Settings → About & Updates.** A manual "Check for updates" button and the
  current app version.

## [0.1.3]

### Fixed
- App data is stored outside `~/Documents`, which stops the macOS privacy prompts
  on launch.

## [0.1.2]

### Added
- Cross-platform release pipeline producing macOS, Windows, and Linux installers.
- Queue mode and the rest of the v0.1.2 feature sprint.
