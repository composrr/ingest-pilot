# Building the macOS App (signed + notarized)

Ingest Pilot's Mac installer (`.dmg`) must be built **on a Mac** — Tauri can't
cross-compile a macOS app from Windows. This guide produces a signed, notarized
universal `.dmg` your team can install with no Gatekeeper warnings.

Estimated time: ~20 min the first time (mostly tool installs + first Rust build).

---

## 1. Get the project onto the Mac

Use the clean source bundle `releases/v0.1.0/ingest-pilot-source.zip` (committed
source only — no `node_modules` or build output). AirDrop / USB / cloud it over,
then unzip into a working folder, e.g. `~/dev/ingest-pilot`.

*(Alternatively, if the repo is on GitHub, just `git clone` it.)*

## 2. Install prerequisites (once per Mac)

```bash
# Xcode command line tools (compiler + codesign + notarytool)
xcode-select --install

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Node 18+ (skip if already installed; or use Homebrew / nvm)
brew install node
```

## 3. Install dependencies & do an unsigned test build first

```bash
cd ~/dev/ingest-pilot
npm install
npm run tauri:build
```

This produces (for your Mac's architecture):
- `src-tauri/target/release/bundle/macos/Ingest Pilot.app`
- `src-tauri/target/release/bundle/dmg/Ingest Pilot_0.1.0_*.dmg`

Open the `.app` to confirm it launches before bothering with signing.

## 4. Build a universal binary (Intel + Apple Silicon)

So one `.dmg` runs on every Mac on the team:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build -- --target universal-apple-darwin
```

## 5. Sign + notarize (uses your Apple Developer account)

### One-time setup
1. **Developer ID Application certificate** — in Xcode → Settings → Accounts →
   your team → *Manage Certificates* → **+** → *Developer ID Application*. It lands
   in your login keychain. Confirm with:
   ```bash
   security find-identity -v -p codesigning
   # copy the line like: "Developer ID Application: Your Name (ABCDE12345)"
   ```
2. **App-specific password** for notarization — create at
   <https://appleid.apple.com> → Sign-In & Security → App-Specific Passwords.
3. **Team ID** — the 10-char code in the cert name above (also on
   developer.apple.com → Membership).

### Build with signing + notarization
Tauri signs **and** notarizes automatically when these env vars are set, then
staples the ticket to the `.dmg`:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="ABCDE12345"

npm run tauri:build -- --target universal-apple-darwin
```

> **Never commit these values.** They're secrets — keep them in your shell session
> or a local untracked `.env`, not in the repo.

The notarized, stapled `.dmg` will be at:
`src-tauri/target/release/bundle/dmg/Ingest Pilot_0.1.0_universal.dmg`

## 6. Verify before sending to the team

```bash
# Signature valid?
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/release/bundle/macos/Ingest Pilot.app"

# Notarization stapled & Gatekeeper-accepted?
spctl -a -vvv -t install \
  "src-tauri/target/release/bundle/macos/Ingest Pilot.app"
# expect: "source=Notarized Developer ID"
```

If both pass, testers can open the `.dmg`, drag the app to Applications, and launch
it with no warnings.

---

## Troubleshooting

- **"errSecInternalComponent" / signing fails** — the Developer ID cert isn't in
  the login keychain, or Xcode CLT isn't installed. Re-check step 5.1.
- **Notarization rejected** — run `xcrun notarytool log <submission-id>` (Tauri
  prints the id) to see why; usually an unsigned nested binary or hardened-runtime
  issue.
- **App opens to a blank window** — already guarded against (Vite `base: "./"`),
  but if it recurs, confirm `dist/index.html` references `./assets/...`.
- **Won't launch on Intel Macs** — you built arch-specific; use the
  `--target universal-apple-darwin` build from step 4/5.

Reference: <https://v2.tauri.app/distribute/sign/macos/>
