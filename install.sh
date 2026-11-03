#!/usr/bin/env bash
# Installs or updates Stem Player from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/PravdeepK/stem-player/main/install.sh | bash
#
# STEM_PLAYER_ZIP          a URL or local path to use instead of the latest release zip
# STEM_PLAYER_INSTALL_DIR  install into this folder instead of /Applications
set -euo pipefail

APP_NAME="Stem Player"
BUNDLE_ID="com.pravdeepk.stemplayer"
ZIP_URL="https://github.com/PravdeepK/stem-player/releases/latest/download/Stem-Player-mac-arm64.zip"
SOURCE="${STEM_PLAYER_ZIP:-$ZIP_URL}"

say() { printf '%s\n' "$*"; }
die() { printf 'Stem Player install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Stem Player only runs on macOS."
# uname -m says x86_64 under Rosetta, so ask the hardware instead.
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ] || die "Stem Player needs a Mac with Apple silicon (M1 or later)."

TMP="$(mktemp -d -t stem-player)"
trap 'rm -rf "$TMP"' EXIT

ZIP="$TMP/$APP_NAME.zip"
case "$SOURCE" in
  http://* | https://*)
    say "Downloading Stem Player..."
    curl -fL --progress-bar -o "$ZIP" "$SOURCE" || die "couldn't download $SOURCE"
    ;;
  *)
    [ -f "$SOURCE" ] || die "no zip at $SOURCE"
    cp "$SOURCE" "$ZIP"
    ;;
esac

ditto -x -k "$ZIP" "$TMP/unpacked" || die "the download isn't a valid zip."
NEW_APP="$TMP/unpacked/$APP_NAME.app"
[ -d "$NEW_APP" ] || die "the zip doesn't contain $APP_NAME.app."
xattr -dr com.apple.quarantine "$NEW_APP" 2>/dev/null || true
codesign --verify --deep --strict "$NEW_APP" 2>/dev/null || die "the app's signature doesn't check out, so it wasn't installed."

can_install_in() { [ -w "$1" ] && { [ ! -e "$1/$APP_NAME.app" ] || [ -w "$1/$APP_NAME.app" ]; }; }
if [ -n "${STEM_PLAYER_INSTALL_DIR:-}" ]; then
  DIR="$STEM_PLAYER_INSTALL_DIR"
  mkdir -p "$DIR"
elif [ -e "$HOME/Applications/$APP_NAME.app" ] && [ ! -e "/Applications/$APP_NAME.app" ]; then
  DIR="$HOME/Applications"
elif can_install_in /Applications; then
  DIR="/Applications"
else
  DIR="$HOME/Applications"
  mkdir -p "$DIR"
fi
can_install_in "$DIR" || die "can't write to $DIR."
DEST="$DIR/$APP_NAME.app"

if pgrep -xq "$APP_NAME"; then
  say "Quitting Stem Player..."
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  for _ in $(seq 20); do pgrep -xq "$APP_NAME" || break; sleep 0.5; done
  if pgrep -xq "$APP_NAME"; then die "Stem Player is still open. Quit it and run this again."; fi
fi

if [ -e "$DEST" ]; then say "Replacing $DEST"; else say "Installing to $DEST"; fi
rm -rf "$DEST"
mv "$NEW_APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --verify --deep --strict "$DEST" || die "the installed app failed its signature check."

say "Stem Player is installed. Opening it..."
open "$DEST"
