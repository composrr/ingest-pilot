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

> **Windows-only bundling.** Only the Windows installer ships ffmpeg + exiftool. macOS
> and Linux fall back to the placeholder tier for cinema-RAW and standard-video
> thumbnails. See "Which platforms bundle" below for the per-platform config mechanism
> and why macOS is deferred.

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

## Which platforms bundle

| Platform | Bundles ffmpeg + exiftool? | How |
|---|---|---|
| **Windows** | **Yes** | `src-tauri/tauri.windows.conf.json` (per-platform override) |
| **macOS** | No (deferred) | base config only — see below |
| **Linux** | No (deferred) | base config only — see below |

### Per-platform config: bundling lives in `tauri.windows.conf.json`, NOT the base

The base `src-tauri/tauri.conf.json` declares **no** `externalBin` and **no** exiftool
resource. That is deliberate: a declared `externalBin: ["binaries/ffmpeg"]` missing at
bundle time makes `tauri build` **fail outright**, and each target triple needs its own
sidecar file present (on macOS universal, that means *both* `aarch64` and `x86_64`). If
bundling were in the base config, every platform's release build would fail unless it
fetched a matching signed sidecar. Keeping the base clean means macOS/Linux build green
with zero tool work.

Windows bundling is layered on via Tauri v2's **platform-specific config override**.
Tauri reads `tauri.conf.json` then, on Windows only, merges `tauri.windows.conf.json`
over it:

```jsonc
// src-tauri/tauri.windows.conf.json  — merged over the base ONLY on Windows
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "externalBin": ["binaries/ffmpeg"],          // no triple, no .exe — Tauri appends them
    "resources": [
      "resources/guides/Ingest-Pilot-Quickstart.pdf",
      "resources/guides/Ingest-Pilot-User-Guide.pdf",
      "resources/guides/Ingest-Pilot-Walkthrough.mp4",
      "resources/tools/exiftool/**/*"            // exe + exiftool_files/ must ship together
    ]
  }
}
```

**Array-merge semantics (load-bearing).** Tauri v2 merges platform configs with
**JSON Merge Patch (RFC 7396)** — verified in `tauri-utils-2.9.1/src/config/parse.rs`
(`json_patch::merge`). Under RFC 7396, objects merge recursively but **arrays are
replaced wholesale**, not concatenated. So `bundle.resources` in the Windows override
**replaces** the base array entirely — which is why the three guide entries are repeated
here. Omit them and the guides would silently vanish from the Windows installer. The
`icons` array in the base is untouched (the override doesn't mention it), so it still
ships.

exiftool **cannot** be a sidecar: the Windows package is `exiftool.exe` *plus* a
508-file `exiftool_files/` Perl runtime, and `externalBin` only handles standalone
single binaries. Hence the resource folder.

### macOS bundling is deferred (notarization + LGPL-universal)

macOS is intentionally left tool-less. Bundling ffmpeg there is high-risk:

- It needs an LGPL **universal** (arm64 + x86_64) ffmpeg. BtbN publishes per-arch
  Windows/Linux builds, not a signed macOS universal LGPL binary — building one means
  compiling ffmpeg from source for both arches and `lipo`-ing them.
- The macOS release leg is **code-signed and notarized** (Apple secrets in `release.yml`).
  Apple's notary service **rejects unsigned nested executables** — a bundled ffmpeg
  sidecar would have to be signed with the same Developer ID and hardened-runtime flags,
  or notarization fails and the whole macOS build goes red.

Both together put it out of scope for this milestone. macOS RED `.R3D`/video thumbnails
degrade to the placeholder tier; `.ARW`/`.CR3`/etc. still work via the pure-Rust `rawler`
path, which needs no bundled binaries.

### Linux is deferred too

Linux bundling *could* be wired the same way (a `scripts/fetch-tools.sh` pulling BtbN's
`linux64-lgpl` ffmpeg to `binaries/ffmpeg-x86_64-unknown-linux-gnu`, plus a
`tauri.linux.conf.json`). It is **not** wired here: the win in this task is Windows, and
exiftool on Linux is a Perl script (not a self-contained PAR exe), so shipping it cleanly
inside an AppImage/deb is fragile enough to risk the currently-green Linux build. Deferred
by choice; ffmpeg-only Linux bundling remains a clean future follow-up.

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

`.github/workflows/release.yml` runs a **Windows-only** fetch step before
`tauri-apps/tauri-action`:

```yaml
- name: Fetch bundled tools (Windows)
  if: matrix.os == 'windows-latest'
  shell: pwsh
  run: pwsh -File scripts/fetch-tools.ps1
```

It sits after `npm ci` and before the `tauri-action` build step. The binaries are
gitignored, so a fresh CI checkout has none; on Windows the merged
`tauri.windows.conf.json` declares `externalBin: ["binaries/ffmpeg"]` plus the exiftool
resource folder, and a declared `externalBin` **missing at bundle time fails
`tauri build` outright** — so the fetch step is mandatory for a green Windows leg.

macOS and Linux have **no** fetch step and **no** tool declarations in their (base-only)
config, so they build green with zero tool work. The `if: matrix.os == 'windows-latest'`
guard is what keeps the mac/linux legs from paying for — or failing on — the Windows-only
PowerShell fetch.

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
