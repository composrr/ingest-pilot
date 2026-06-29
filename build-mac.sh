#!/usr/bin/env bash
# Build a signed + notarized universal macOS .dmg for Ingest Pilot.
# Run on a Mac from the project root:  bash build-mac.sh
# Secrets are prompted at runtime and never stored.
set -euo pipefail

say()  { printf "\n\033[1;36m==>\033[0m %s\n" "$1"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; exit 1; }

# 0. Must run from the project root.
grep -q '"name": "ingest-pilot"' package.json 2>/dev/null \
  || fail "Run this from the unzipped ingest-pilot folder (where package.json lives)."

# 1. Xcode Command Line Tools.
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools — finish the popup, then re-run this script."
  xcode-select --install || true
  fail "Re-run 'bash build-mac.sh' once the Command Line Tools finish installing."
fi

# 2. Rust.
if ! command -v cargo >/dev/null 2>&1; then
  say "Installing Rust (rustup)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env" 2>/dev/null || true

# 3. Node.
command -v npm >/dev/null 2>&1 || fail "Node.js/npm not found. Install it (e.g. 'brew install node') and re-run."

# 4. Universal build targets.
say "Adding Rust targets for Intel + Apple Silicon..."
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 5. Frontend/JS dependencies.
say "Installing npm dependencies..."
npm install

# 6. Auto-detect the Developer ID Application signing identity.
say "Looking for a 'Developer ID Application' certificate..."
IDENTITY=$(security find-identity -v -p codesigning \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)".*/\1/')
[ -n "${IDENTITY:-}" ] || fail "No 'Developer ID Application' cert in your keychain. Create one in Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application, then re-run."
printf "    Using: %s\n" "$IDENTITY"
DETECTED_TEAM=$(printf "%s" "$IDENTITY" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')

# 7. Notarization credentials (prompted, not stored).
say "Notarization credentials (Apple Developer account):"
read -r -p "    Apple ID email: " APPLE_ID
read -r -s -p "    App-specific password (appleid.apple.com): " APPLE_PASSWORD; printf "\n"
read -r -p "    Team ID [$DETECTED_TEAM]: " TEAM_INPUT
APPLE_TEAM_ID="${TEAM_INPUT:-$DETECTED_TEAM}"
[ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ] \
  || fail "Apple ID, app-specific password, and Team ID are all required to notarize."

# 8. Signed + notarized universal build.
say "Building signed + notarized universal .dmg (this can take several minutes)..."
export APPLE_SIGNING_IDENTITY="$IDENTITY"
export APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
npm run tauri:build -- --target universal-apple-darwin

# 9. Verify.
APP="src-tauri/target/release/bundle/macos/Ingest Pilot.app"
say "Verifying signature + notarization..."
codesign --verify --deep --strict --verbose=2 "$APP" || true
spctl -a -vvv -t install "$APP" || true

# 10. Result.
say "Done. Built installer(s):"
ls -1 src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
open src-tauri/target/release/bundle/dmg/ 2>/dev/null || true
