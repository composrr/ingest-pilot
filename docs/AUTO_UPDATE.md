# Auto-update

Ingest Pilot updates itself using Tauri's updater plugin. On launch it checks a
manifest hosted on a **public** releases repo, and if a newer **signed** build
exists it shows a "What's new" popup and installs the update with your approval.

Source code stays in the private repo; only built installers + the update manifest
live in the public repo, so the app can fetch updates without any embedded secret.

```
tag push (private repo)
   └─ Release workflow: build + sign (3 OSes)
        └─ publish installers + latest.json  ──▶  composrr/ingest-pilot-releases (public)
                                                      ▲
        app launch ── check() ─────────────────────────┘
             └─ UpdateModal (changelog) ─▶ download + install ─▶ relaunch
```

## How it behaves

- **On launch:** a background check. If up to date or offline, nothing happens and
  the app opens normally (failures are logged, never shown).
- **Update found:** a modal shows `vCURRENT → vNEW` and the changelog, with
  **Install now** / **Later**. Install shows a progress bar, then the app restarts.
- **Manually:** Settings → *About & Updates* → **Check for updates**.

The changelog text comes from `CHANGELOG.md` (see that file's header).

## One-time setup (do this at go-live)

Everything below is external to the code and only needs doing once.

### 1. Create the public releases repo

Create `composrr/ingest-pilot-releases` as a **public** repo with an initial commit
on `main` (a README is enough). The updater endpoint and the release workflow both
target this name — if you use a different name, update:

- `plugins.updater.endpoints` in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json)
- `owner` / `repo` in [`.github/workflows/release.yml`](../.github/workflows/release.yml)

### 2. Create a cross-repo token

The default `GITHUB_TOKEN` can't write to another repo, so create a PAT that can:

- **Fine-grained PAT** scoped to `ingest-pilot-releases`, with **Contents: Read and
  write** (and **Metadata: Read**), or
- **Classic PAT** with the `repo` scope.

### 3. Add secrets to the **private** repo (`composrr/ingest-pilot`)

The workflow runs in the private repo, so the secrets live there:

```bash
# From a checkout of the private repo, authenticated with gh:
gh secret set RELEASES_TOKEN            --repo composrr/ingest-pilot   # paste the PAT
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo composrr/ingest-pilot < ~/.tauri/ingest-pilot-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo composrr/ingest-pilot --body ""
```

On Windows PowerShell, set the key from the file with:

```powershell
Get-Content "$env:USERPROFILE\.tauri\ingest-pilot-updater.key" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo composrr/ingest-pilot
```

That's it — no signing config needs to change in the code; the public key is already
committed in `tauri.conf.json`.

## Cutting a release

1. Bump the version in **all three** files (they must match):
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Add a `## [x.y.z]` section to `CHANGELOG.md` describing the changes.
3. Commit, then tag and push:
   ```bash
   git tag v0.1.4
   git push origin v0.1.4
   ```
4. The Release workflow builds, signs, and publishes installers + `latest.json` to
   the public repo. Existing users get the popup on their next launch.

The updater only offers a build whose version is **greater** than the installed one,
so the version bump in step 1 is what makes an update appear.

## The signing key

- Generated with `tauri signer generate` (no password); the private key is at
  `~/.tauri/ingest-pilot-updater.key` on the machine that created it, and the public
  key is committed in `tauri.conf.json`.
- **Back up the private key somewhere safe.** If it's lost, you can't sign updates
  that existing installs will accept — you'd have to ship a new public key in a build
  that users install manually, breaking the auto-update chain once.
- To rotate: `tauri signer generate -w ~/.tauri/ingest-pilot-updater.key -f`, replace
  `pubkey` in `tauri.conf.json`, and update the `TAURI_SIGNING_PRIVATE_KEY` secret.

## Platform signing caveats (separate from updater signing)

The minisign signing above is what the updater verifies. OS-level code signing is a
different thing and is **not** set up yet:

- **macOS:** an unsigned/un-notarized app may be quarantined by Gatekeeper after an
  update. For a smooth experience, add Apple Developer signing + notarization to the
  workflow later.
- **Windows:** without an Authenticode certificate, SmartScreen may warn on install.
  The updater still works; the warning is cosmetic.

These don't block auto-update from functioning — they only affect OS trust prompts.
