#!/usr/bin/env bash
# Put this checkout's MemoryLake connector into WorkBuddy's connector list on
# this Mac, before it is published, so someone can try it in the real app.
#
#   workbuddy-connector/dev/try-in-workbuddy.sh           # show it, restart WorkBuddy
#   workbuddy-connector/dev/try-in-workbuddy.sh --undo    # back to the official list
#   add --no-restart to leave WorkBuddy running
#
# WorkBuddy 5.11.3 takes its connector list from a market API, which only
# lists published connectors. Started with WORKBUDDY_CONNECTOR_MARKET_API=0 it
# reads the older marketplace index instead, and that index can be overridden
# by ~/.workbuddy/connectors/connector-marketplace.json. So this builds an
# index of the official connectors plus this one, serves it on 127.0.0.1, points
# the override at it and restarts WorkBuddy with the market API off. The
# environment variable applies to that launch only: quitting and reopening
# WorkBuddy the usual way brings the official list back.
#
# Needs macOS, WorkBuddy opened at least once, and python3.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package="$here/../memorylake-cli"
state="$HOME/.memorylake-connector-test"
override="$HOME/.workbuddy/connectors/connector-marketplace.json"
port=18766
url="http://127.0.0.1:$port/connectors-config.zip"

undo=false
restart=true
for arg in "$@"; do
  case "$arg" in
    --undo) undo=true ;;
    --no-restart) restart=false ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The server this script started: whatever serves http.server on the port.
# (A python3 launcher may hand off to another process, so its PID is no use.)
stop_server() {
  local pid
  for pid in $(lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null); do
    if ps -o command= -p "$pid" | grep -q "http.server $port"; then kill "$pid" 2>/dev/null || true; fi
  done
}

restart_workbuddy() {
  $restart || return 0
  if pgrep -f "/WorkBuddy.app/Contents/MacOS/" >/dev/null; then
    echo "Quitting WorkBuddy..."
    osascript -e 'quit app "WorkBuddy"' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      pgrep -f "/WorkBuddy.app/Contents/MacOS/" >/dev/null || break
      sleep 1
    done
  fi
  echo "Starting WorkBuddy $1..."
  if [[ "$1" == "with the test list" ]]; then
    open -a WorkBuddy --env WORKBUDDY_CONNECTOR_MARKET_API=0
  else
    open -a WorkBuddy
  fi
}

if $undo; then
  stop_server
  if [[ -f "$state/override.backup" ]]; then
    mv "$state/override.backup" "$override"
  elif [[ -f "$override" ]] && grep -q "$url" "$override"; then
    rm "$override"
  fi
  restart_workbuddy "the usual way"
  echo "Done: WorkBuddy shows the official connector list again."
  echo "A connected MemoryLake stays connected until you disconnect it in WorkBuddy."
  exit 0
fi

[[ "$(uname)" == Darwin ]] || { echo "This script is for macOS." >&2; exit 1; }
[[ -d /Applications/WorkBuddy.app ]] || { echo "WorkBuddy is not installed in /Applications." >&2; exit 1; }
[[ -d "$HOME/.workbuddy/connectors-marketplace/.codebuddy-connector" ]] || {
  echo "WorkBuddy has not downloaded its connector list yet: open WorkBuddy, sign in, open the connector list once, then run this again." >&2
  exit 1
}
command -v python3 >/dev/null || { echo "python3 is needed (xcode-select --install provides it)." >&2; exit 1; }

mkdir -p "$state/www" "$(dirname "$override")"
python3 "$here/build-test-marketplace.py" "$package" "$state/www/connectors-config.zip"

stop_server
sleep 0.5
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is taken by another program; stop it and run this again." >&2
  exit 1
fi
nohup python3 -m http.server "$port" --bind 127.0.0.1 --directory "$state/www" >"$state/server.log" 2>&1 &
disown
for _ in 1 2 3 4 5; do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "$url" || { echo "The local server did not start; see $state/server.log" >&2; exit 1; }

if [[ -f "$override" ]] && ! grep -q "$url" "$override" && [[ ! -f "$state/override.backup" ]]; then
  cp "$override" "$state/override.backup"
fi
printf '{"connectorMarketplaceUrl":"%s"}\n' "$url" >"$override"

restart_workbuddy "with the test list"
cat <<EOF
Done. In WorkBuddy open the connector list: MemoryLake is first. Click Connect.
The test list lasts until WorkBuddy is quit and reopened the usual way; run
this script again to bring it back. To undo everything:
  $here/try-in-workbuddy.sh --undo
EOF
