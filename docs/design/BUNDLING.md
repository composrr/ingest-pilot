# Bundling ffmpeg & exiftool (report thumbnails)

The Phase B thumbnail ladder (`src-tauri/src/ingest/copier.rs`) needs two external
binaries for full coverage. **Neither is required to build or run** — when a binary is
missing, discovery returns `None` and that file falls through to the styled per-format
placeholder tier. The pure-Rust `rawler` path (Sony `.ARW`, Canon `.CR2/.CR3`, Nikon
`.NEF`, Adobe `.DNG`, …) needs **no** bundled binaries at all.

| Tool | Fixes | Bundling shape | Discovery |
|------|-------|----------------|-----------|
| **ffmpeg** (LGPL static) | standard video poster frames (FX3 `.mp4`/`.mov`) + clip durations | Tauri **sidecar** (`externalBin`), target-triple suffix | `INGEST_PILOT_FFMPEG` env → exe-adjacent / ancestor dirs → `node_modules/ffmpeg-static` → PATH |
| **exiftool** | cinema-RAW previews — RED `.R3D` and Canon `.CRM` (see caveat below) | Tauri **resource** folder (`exiftool.exe` + `exiftool_files/`) | `INGEST_PILOT_EXIFTOOL` env → resource dir → PATH |

> Windows-first this milestone. macOS/Linux fall back to the placeholder tier for
> cinema-RAW until signed/notarized tool bundles are added.

> **Caveat — `.BRAW` / `.CINE` are not actually covered.** `copier.rs` routes
> `.r3d`/`.braw`/`.crm`/`.cine` to exiftool, but exiftool 13.59's readable-format list
> (`exiftool -listf`) includes **R3D and CRM only** — not BRAW or CINE. Those two
> extensions degrade to the placeholder card. Verified: `exiftool -listf | grep -i braw`
> returns nothing. Blackmagic `.BRAW` would need Blackmagic's own SDK.

---

## Quick start

The binaries are **not committed** (~141 MB combined — see `.gitignore`). Fetch them:

```powershell
pwsh -File scripts/fetch-tools.ps1
```

Then **restart `npm run tauri:dev`** — the env wiring happens once in `setup`, so a
running dev app will not pick up newly-fetched tools.

`scripts/fetch-tools.ps1` is idempotent (re-runs skip working tools; `-Force`
re-downloads), SHA-256-verifies every download against the publisher's own checksum
file, asserts ffmpeg is **not** a GPL build, clears stale staged copies, and prints both
versions when it finishes.

## What lands where

```
src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe    <- sidecar (triple suffix REQUIRED)
src-tauri/resources/tools/exiftool/exiftool.exe          <- resource
src-tauri/resources/tools/exiftool/exiftool_files/       <- resource (bundled Perl runtime)
```

Current pinned versions: **ffmpeg n8.1.2-22-g94138f6973** (BtbN **LGPL static** build,
**108.3 MB** — only `ffmpeg.exe` is kept; ffplay/ffprobe/docs are dropped) and
**exiftool 13.59** (32.9 MB including `exiftool_files/`).

Sources — exact, for reproducibility:

| | Value |
|---|---|
| ffmpeg release | `autobuild-2026-07-15-14-01` (BtbN/FFmpeg-Builds) |
| ffmpeg asset | `ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-8.1.zip` |
| ffmpeg checksum | `checksums.sha256` from the same release |
| exiftool | `exiftool-13.59_64.zip` from exiftool.org, falling back to SourceForge |

The ffmpeg release tag is a **dated `autobuild-*` tag, which is immutable** — deliberately
not the `latest` tag, whose assets are replaced in place. Both are overridable
(`-FfmpegRelease` / `-FfmpegAsset`).

exiftool.org rate-limits aggressively; in practice the SourceForge mirror (the author's
own) is what serves the download.

> The fetch script sends a non-browser `User-Agent`. This is load-bearing for the
> SourceForge mirror: browser-ish agents get a 403 or an **HTML interstitial page served
> in place of the archive**. The SHA-256 gate catches that (it's how it was found), but
> the UA is what makes the download succeed.

## tauri.conf.json

```jsonc
"bundle": {
  "externalBin": ["binaries/ffmpeg"],          // no triple, no .exe — Tauri appends them
  "resources": [
    "resources/guides/Ingest-Pilot-Quickstart.pdf",
    "resources/guides/Ingest-Pilot-User-Guide.pdf",
    "resources/guides/Ingest-Pilot-Walkthrough.mp4",
    "resources/tools/exiftool/**/*"            // exe + exiftool_files/ must ship together
  ]
}
```

exiftool **cannot** be a sidecar: the Windows package is `exiftool.exe` *plus* a
508-file `exiftool_files/` Perl runtime, and `externalBin` only handles standalone
single binaries. Hence the resource folder.

## How discovery resolves

`wire_bundled_tool_env()` (`src-tauri/src/lib.rs`) runs once in `setup` and exports
`INGEST_PILOT_FFMPEG` / `INGEST_PILOT_EXIFTOOL` for the Tauri-agnostic extractors in
`copier.rs` (which read env → ancestor dirs → PATH). It **never** overrides an env var
you set yourself, and it is a no-op when the binaries are absent — never a panic.

It probes these roots, most-authoritative first:

1. `resource_dir()` — the packaged install.
2. Up to 4 ancestors of the running exe — where sidecars land next to the app binary.
3. `CARGO_MANIFEST_DIR` (**debug builds only**) — the dev source tree. `cfg`-gated so a
   release build can never reach back to a build-machine path.

**Why dev needs step 3:** under `tauri dev`, `resource_dir()` points at
`src-tauri/target/<profile>`, *not* at the source `resources/` folder.

In practice `tauri-build` stages both tools into `target/debug/` on every build —
`target/debug/ffmpeg.exe` (triple stripped) and `target/debug/resources/tools/exiftool/`
(complete, all 508 files) — so dev usually resolves via step 2, which conveniently
mirrors the packaged layout. Step 3 is the fallback that keeps dev working regardless.

> Historical bug, now fixed: the old code looked for exiftool at
> `resource_dir/tools/exiftool/…`, missing the `resources/` path segment that Tauri
> actually preserves. It never resolved, in dev *or* packaged.

### Gotcha: stale staged copies shadow a freshly-fetched tool

Because discovery prefers the exe-adjacent staged copy, a *previously staged* tool in
`target/<profile>/` silently wins over a newly-fetched one — and `cargo check` alone does
**not** re-run `build.rs`, so it does not re-stage. This is not hypothetical: it is how
the rejected **GPL** ffmpeg kept being used after the LGPL binary had been installed.

`scripts/fetch-tools.ps1` therefore deletes `target/<profile>/ffmpeg.exe` and
`target/<profile>/resources/tools/exiftool` at the end of every run. The next build
re-stages; until then discovery falls through to the source tree. If you ever swap a
binary by hand, clear those paths yourself.

### Note: there is a second, GPL ffmpeg in `node_modules`

`ffmpeg-static` (a **devDependency**) ships its own GPL ffmpeg 6.1.1 at
`node_modules/ffmpeg-static/ffmpeg.exe`, and `copier.rs`'s discovery lists it as a late
fallback. It is **not** a distribution concern — `node_modules` is not bundled into the
installer, so only the LGPL binary ships. It only matters in dev, and only if the
`INGEST_PILOT_FFMPEG` wiring were to fail, in which case dev could quietly fall back to a
GPL binary. Worth removing the devDependency if nothing else uses it.

## CI

**CI must run `scripts/fetch-tools.ps1` before `tauri build`.** The binaries are
gitignored, so a fresh clone has neither, and a declared `externalBin` that is missing at
bundle time is expected to fail the build outright (not verified here — no full release
build was run). Either way, a release built without the fetch step ships without
thumbnail support at best.

## Licensing — needs sign-off before shipping

Both tools are invoked as separate processes (aggregation, not linking), so neither
imposes its license on Ingest Pilot's own source. Obligations attach to the **binaries we
redistribute** inside the installer.

- **exiftool 13.59** — Perl Artistic / GPL. Shipped unmodified and separately invoked:
  the standard, well-trodden arrangement. Ship its license text with the app.
  **Flag for sign-off.**
- **ffmpeg n8.1.2 (BtbN, win64 LGPL static)** — **LGPLv3.** This build was chosen
  *specifically* to avoid GPL. Verified from the build's own config string:
  - **no `--enable-gpl`** — the decisive flag. ffmpeg is LGPL **by default**; you opt
    *into* GPL. (There is no `--enable-lgpl` flag to look for — its absence proves
    nothing either way. `--enable-gpl` is the only thing that matters.)
  - **no `--enable-nonfree`** — so the binary is redistributable at all.
  - `--enable-version3` **is** present, and that is *not* a GPL marker: it is orthogonal
    to `--enable-gpl` and only moves (L)GPLv2.1 → v3 (some LGPL deps require it). With
    `--enable-gpl` absent, this build is **LGPLv3**.
  - `--disable-libx264 --disable-libx265 --disable-libxvid` — the GPL-only encoders are
    compiled out, consistent with a true LGPL build.

  `scripts/fetch-tools.ps1` **re-asserts this on every install** and refuses to install a
  binary reporting `--enable-gpl` or `--enable-nonfree`, so a future version bump cannot
  silently reintroduce a GPL binary.

  **What LGPLv3 obliges** (vs. the GPLv3 gyan.dev build we rejected): ship the LGPLv3
  text and offer the corresponding ffmpeg source. Crucially it does **not** impose
  copyleft on Ingest Pilot itself. One caveat worth legal's attention: this is a
  **statically linked** LGPL binary, and LGPLv3 §4 asks that recipients be able to
  relink against a modified library — normally satisfied by also offering the object
  files, or by switching to the `-shared` build (`…-win64-lgpl-shared-8.1.zip`, exe +
  DLLs) where relinking is inherent. **Flag for sign-off.**

  > Rejected: `gyan.dev` "essentials" ffmpeg 8.1.2 — `--enable-gpl --enable-version3`,
  > i.e. **GPLv3**. It was redistributable but carried copyleft obligations on the
  > distributed bundle.

### Codec coverage after the LGPL swap — no loss for our use case

Dropping the GPL encoders (libx264/libx265/libxvid) costs us nothing: thumbnails only
ever **decode**. Verified present in this build — `h264`, `hevc`, `prores` (+
`prores_raw`), `dnxhd`, `mjpeg`, `vp9`, `av1` decoders, and the `mov,mp4` + `mxf`
demuxers that Sony XAVC arrives in. Encoding, if ever needed, is still covered by the
non-GPL `libopenh264` / `libkvazaar` / hardware (`nvenc`/`amf`/`qsv`/`mf`) encoders.
End-to-end checked: poster-frame extraction from both H.264 and ProRes, plus the
`Duration:` line that `probe_duration_ms()` parses.

## Verify after fetching

- `.mp4` (FX3) → poster frame + duration in HTML report and PDF proof.
- `.arw` (A7IV) → embedded preview via rawler (works even with zero bundled binaries).
- `.r3d` → exiftool-extracted preview.
- `.braw` / `.cine` → placeholder card (expected; see caveat above).
- Anything unsupported → styled `ARW`/`R3D`/… placeholder card, never a blank box.

`cargo test --lib` covers the resolution logic: the dev source layout, the packaged
layout, the absent-tools no-op, the env-override precedence, and — when the tools have
actually been fetched — that dev discovery resolves a *working* exiftool (one that still
has its `exiftool_files/` sibling).
