#!/usr/bin/env bash
# install.sh - register starlink-monitor with launchd, start it, and prove it started.
#
# Five jobs:
#   server      always running, serves the dashboard + API on 127.0.0.1:8787
#   menubar     always running, the status item
#   light       every 5 minutes, cheap, uses no bandwidth
#   speedtest   every 60 minutes, runs Starlink's own dish->PoP test
#   quality     every 6 hours, networkQuality, moves ~200 MB
#
#   ./install.sh            install, then verify
#   ./install.sh status     verify an existing install (the health check)
#   ./install.sh uninstall  remove jobs, app and icon. Keeps the data
#
# Why there is a verify step at all: `launchctl bootstrap` returning 0 only
# means launchd accepted the plist. It does not mean the job runs, the port
# listens, or a measurement lands. This monitor was found in exactly that
# state once - menu bar present, four jobs silently unregistered, no data for
# four days - so the installer now refuses to claim success it has not checked.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LA="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/.8gent/starlink"
PREFIX="com.8gi.starlink"
PORT="${STARLINK_PORT:-8787}"
UID_="$(id -u)"
APP="/Applications/Starlink Monitor.app"
DESKTOP_LINK="$HOME/Desktop/Starlink Monitor"

jobs=(server menubar light speedtest quality)

# ---------------------------------------------------------------- helpers --

# A job launchd has actually registered in this user's GUI domain. `launchctl
# list | grep` is not enough: it answers for the label, not the domain, and a
# job can be absent from the domain while its plist still sits on disk.
registered() { launchctl print "gui/$UID_/$PREFIX.$1" >/dev/null 2>&1; }

api() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/status" 2>/dev/null; }

# Seconds since the newest recorded measurement, or empty if unknown. This is
# the check that catches a live server serving stale numbers.
probe_age() {
  local body ts base epoch
  body="$(api)" || return 1
  # The first "ts" in the payload is the measurement timestamp. Every alert
  # carries a "ts" of its own further down, and a greedy match lands on the
  # oldest open alert instead - which reads as "stale" on a perfectly fresh
  # install. Take the first match, explicitly.
  ts="$(printf '%s' "$body" | grep -o '"ts":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "$ts" ]; then return 1; fi
  base="${ts%%.*}"; base="${base%Z}"
  epoch="$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$base" +%s 2>/dev/null)" || return 1
  echo $(( $(date +%s) - epoch ))
}

human_age() {
  local s="$1"
  if [ "$s" -lt 120 ]; then echo "${s}s ago"
  elif [ "$s" -lt 7200 ]; then echo "$(( s / 60 ))m ago"
  else echo "$(( s / 3600 ))h ago"; fi
}

# Verify. Returns non-zero if anything is not actually working.
# $1 = seconds to wait for the first measurement (0 when only reporting).
verify() {
  local grace="${1:-0}" bad=0 j age waited

  echo "checking launchd registration"
  for j in "${jobs[@]}"; do
    if registered "$j"; then
      echo "  ok       $PREFIX.$j"
    else
      echo "  MISSING  $PREFIX.$j"
      bad=1
    fi
  done

  echo "checking the dashboard on 127.0.0.1:$PORT"
  waited=0
  until api >/dev/null 2>&1; do
    if [ "$waited" -ge "$grace" ]; then break; fi
    sleep 2; waited=$(( waited + 2 ))
  done
  if api >/dev/null 2>&1; then
    echo "  ok       /api/status answers"
  else
    echo "  DOWN     nothing answering on 127.0.0.1:$PORT"
    bad=1
  fi

  echo "checking that measurements are landing"
  waited=0
  age="$(probe_age || true)"
  while [ -z "$age" ] || [ "$age" -gt 900 ]; do
    if [ "$waited" -ge "$grace" ]; then break; fi
    sleep 2; waited=$(( waited + 2 ))
    age="$(probe_age || true)"
  done
  if [ -z "$age" ]; then
    echo "  NO DATA  no measurement recorded yet"
    bad=1
  elif [ "$age" -gt 900 ]; then
    # light runs every 5 minutes. Past 15 the probes have stopped, whatever
    # the menu bar is showing.
    echo "  STALE    newest measurement $(human_age "$age") (light runs every 5m)"
    bad=1
  else
    echo "  ok       newest measurement $(human_age "$age")"
  fi

  if [ "$bad" -ne 0 ]; then
    echo
    echo "NOT HEALTHY."
    echo "If jobs show MISSING, the usual cause is macOS having switched them off:"
    echo "  System Settings > General > Login Items & Extensions > Allow in the Background"
    echo "Turning an item off there boots the job out immediately and keeps it off"
    echo "across reboots, without any error anywhere. Re-enable it, then run:"
    echo "  ./install.sh status"
    echo "Otherwise read the logs: $LOGDIR/*.err"
    return 1
  fi

  echo
  echo "HEALTHY. dashboard: http://127.0.0.1:$PORT"
  return 0
}

# ------------------------------------------------------------ subcommands --

case "${1:-install}" in
  status)
    verify 0
    exit $?
    ;;
  uninstall)
    for j in "${jobs[@]}"; do
      launchctl bootout "gui/$UID_/$PREFIX.$j" 2>/dev/null || true
      rm -f "$LA/$PREFIX.$j.plist"
    done
    rm -rf "$APP"
    rm -f "$DESKTOP_LINK"
    echo "uninstalled. data kept at $LOGDIR"
    exit 0
    ;;
  install) ;;
  *)
    echo "usage: ./install.sh [install|status|uninstall]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------- install --

if ! BUN="$(command -v bun)"; then
  echo "bun is required and is not on PATH. Install it with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

mkdir -p "$LA" "$LOGDIR"

echo "building app bundle..."
bash "$ROOT/menubar/build-app.sh" "$APP"

# Desktop icon. A Finder alias rather than a symlink: an alias survives the app
# being rebuilt in place and shows the real app icon, where a symlink shows a
# generic one.
osascript >/dev/null 2>&1 <<OSA || ln -sfn "$APP" "$DESKTOP_LINK"
tell application "Finder"
  set appFile to POSIX file "$APP" as alias
  set desktopFolder to path to desktop folder
  if exists file "Starlink Monitor" of desktopFolder then
    delete file "Starlink Monitor" of desktopFolder
  end if
  make new alias file at desktopFolder to appFile
  set name of result to "Starlink Monitor"
end tell
OSA
echo "  desktop icon: $DESKTOP_LINK"

# $1 label, $2 interval seconds (0 = keepalive daemon), $3 run-at-load, $4.. args
#
# Only cheap jobs run at load. speedtest and quality wait for their first
# interval instead: firing every probe in the same second made three concurrent
# system_profiler calls return empty, and made a fresh install immediately
# spend ~200 MB on a networkQuality run nobody asked for.
write_plist() {
  local name="$1"; shift
  local interval="$1"; shift
  local atload="$1"; shift
  local label="$PREFIX.$name"
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done

  local schedule
  if [ "$interval" = "0" ]; then
    schedule="  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>"
  else
    schedule="  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><$atload/>"
  fi

  cat > "$LA/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
$schedule
  <key>StandardOutPath</key><string>$LOGDIR/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/$name.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin</string>
    <key>STARLINK_AGENT</key><string>1</string>
  </dict>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$UID_" "$LA/$label.plist" 2>/tmp/starlink-bootstrap.$$; then
    echo "  FAILED to bootstrap $label: $(cat /tmp/starlink-bootstrap.$$)" >&2
    rm -f /tmp/starlink-bootstrap.$$
    return 1
  fi
  rm -f /tmp/starlink-bootstrap.$$
  # Deliberately not printed as "loaded". Whether it is loaded is decided by
  # verify() below, against evidence, not by this call returning 0.
  echo "  registered $label"
}

write_plist server    0     true  "$BUN" "run" "$ROOT/src/server.ts"
write_plist menubar   0     true  "$APP/Contents/MacOS/StarlinkBar"
write_plist light     300   true  "$BUN" "run" "$ROOT/src/probe.ts" "light"
write_plist speedtest 3600  false "$BUN" "run" "$ROOT/src/probe.ts" "speedtest"
write_plist quality   21600 false "$BUN" "run" "$ROOT/src/probe.ts" "quality"

echo
echo "verifying (the first measurement takes a few seconds)"
verify 60
