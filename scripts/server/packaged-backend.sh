#!/bin/sh
# Bootstrap the adjacent launcher with the installed official Electron/ASAR runtime.
set -eu
app=
next=
for arg in "$@"; do
  if [ "$next" = app ]; then app=$arg; next=; continue; fi
  case "$arg" in
    --app) next=app ;;
    --app=*) app=${arg#--app=} ;;
    --help) printf '%s\n' 'Usage: packaged-backend.sh --app /Applications/Zhuma.app --data /path/to/backend-data [--host IP] [--port PORT] [--file-uploads] [--independent-reviews]'; exit 0 ;;
  esac
done
if [ -z "$app" ] || [ -n "$next" ]; then printf '%s\n' 'Pass --app and --data explicitly; use --help for usage.' >&2; exit 64; fi
identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null) || { printf '%s\n' 'Cannot read the installed App metadata.' >&2; exit 1; }
if [ "$identifier" != dev.zhuma.app ]; then printf '%s\n' 'Select the installed Zhuma App.' >&2; exit 1; fi
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null) || { printf '%s\n' 'Cannot read the installed App metadata.' >&2; exit 1; }
case "$executable" in ''|.|..|*/*) printf '%s\n' 'Invalid App executable metadata.' >&2; exit 1 ;; esac
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec /usr/bin/env -i PATH="${PATH:-/usr/bin:/bin}" LANG=en_US.UTF-8 ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/$executable" --expose-internals "$directory/packaged-backend.mjs" "$@"
