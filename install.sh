#!/usr/bin/env bash
# Installs or updates Stem Player from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/PravdeepK/stem-player/main/install.sh | bash
#
# It says whether it's installing, updating (and from which version) or already
# up to date, in which case it downloads nothing.
#
# STEM_PLAYER_ZIP          a URL or local path to use instead of the latest release zip
# STEM_PLAYER_INSTALL_DIR  install into this folder instead of /Applications
set -euo pipefail

APP_NAME="Stem Player"
BUNDLE_ID="com.pravdeepk.stemplayer"
RELEASES="https://github.com/PravdeepK/stem-player/releases"
ZIP_URL="$RELEASES/latest/download/Stem-Player-mac-arm64.zip"
SOURCE="${STEM_PLAYER_ZIP:-$ZIP_URL}"

say() { printf '%s\n' "$*"; }
die() { printf 'Stem Player install failed: %s\n' "$*" >&2; exit 1; }
# An app's version from its Info.plist, or nothing. PlistBuddy reports a
# missing file on stdout, so its output only counts when it succeeds.
version_of() {
  local v
  v="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null)" && printf '%s' "$v"
  return 0
}
# Whether version $2 comes after $1.
is_newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$2" ]; }

[ "$(uname -s)" = "Darwin" ] || die "Stem Player only runs on macOS."
# uname -m says x86_64 under Rosetta, so ask the hardware instead.
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ] || die "Stem Player needs a Mac with Apple silicon (M1 or later)."

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

OLD_VERSION=""
[ -d "$DEST" ] && OLD_VERSION="$(version_of "$DEST")"

# The latest release's version, from where /releases/latest redirects to. Only
# asked for an update of the real release, and an update goes ahead without it.
if [ -n "$OLD_VERSION" ] && [ -z "${STEM_PLAYER_ZIP:-}" ]; then
  LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest" 2>/dev/null | sed -n 's#.*/tag/v##p' || true)"
  if [ "$LATEST" = "$OLD_VERSION" ]; then
    say "Stem Player $OLD_VERSION is already up to date."
    open "$DEST"
    exit 0
  fi
fi

TMP="$(mktemp -d -t stem-player)"
trap 'rm -rf "$TMP"' EXIT

ZIP="$TMP/$APP_NAME.zip"
case "$SOURCE" in
  http://* | https://*)
    if [ -n "$OLD_VERSION" ]; then say "Downloading the latest Stem Player..."; else say "Downloading Stem Player..."; fi
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
NEW_VERSION="$(version_of "$NEW_APP")"

if pgrep -xq "$APP_NAME"; then
  say "Quitting Stem Player..."
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  for _ in $(seq 20); do pgrep -xq "$APP_NAME" || break; sleep 0.5; done
  if pgrep -xq "$APP_NAME"; then die "Stem Player is still open. Quit it and run this again."; fi
fi

if [ -z "$OLD_VERSION" ] && [ ! -e "$DEST" ]; then
  ACTION=install
  say "Installing Stem Player $NEW_VERSION in $DIR..."
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  ACTION=reinstall
  say "Reinstalling Stem Player $NEW_VERSION..."
elif is_newer "$OLD_VERSION" "$NEW_VERSION"; then
  ACTION=update
  say "Updating Stem Player ${OLD_VERSION:-from an unknown version} → $NEW_VERSION..."
else
  ACTION=replace
  say "Replacing Stem Player $OLD_VERSION with the older $NEW_VERSION..."
fi
rm -rf "$DEST"
mv "$NEW_APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --verify --deep --strict "$DEST" || die "the installed app failed its signature check."

case "$ACTION" in
  install) say "Stem Player $NEW_VERSION is installed." ;;
  update)
    say "Stem Player is updated to $NEW_VERSION. Your songs, settings and stem engine are kept."
    if [ -z "${STEM_PLAYER_ZIP:-}" ]; then say "What's new: $RELEASES/tag/v$NEW_VERSION"; fi
    ;;
  *) say "Stem Player $NEW_VERSION is installed. Your songs, settings and stem engine are kept." ;;
esac
say "Opening it..."
open "$DEST"
