#!/bin/bash
# Every browser drive against fresh servers: the fake Gemini and the three app servers it needs
# (any key, no key, pointed at the fake), each on a free port, started here and stopped on exit,
# so a run never meets another run's rate gate or the fake's spent "broken line". Then
# ui/tools/drives.sh. Build first (ui/build.sh) and make the fixture (ui/tools/fixture.sh).
#
#   ui/tools/e2e.sh [shots dir]        (default .e2e/shots)
#
# The app server under test is node ui/server/serve.mjs (removed at L4), AMGI_SERVER=c for the C
# server (server/build/amgi serve, on cbase), or AMGI_SERVER=<executable> (run from the repo root with
# no arguments), so the same drives check another implementation of the server unchanged
# (test/parity/servers.mjs takes the same variable). Each is asked for a free port (PORT=0, and
# CBASE_LISTEN=127.0.0.1:0 for cbase) and says where it listens: "amgi on <url>" or cbase's
# "cbase: listening <host:port>".
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
shots="${1:-$root/.e2e/shots}"
logs="$root/.e2e/servers"
mkdir -p "$shots" "$logs"
# states.mjs builds collections of its own, as ui/tools/fixture.sh does.
for v in ANKI_PYTHON_BIN ANKI_FIXTURE_APKG; do
  if [ -z "${!v:-}" ]; then echo "set $v (see the e2e-ui skill)" >&2; exit 1; fi
done
if [ "${AMGI_SERVER:-}" = c ]; then server=("$root/server/build/amgi" serve)
elif [ -n "${AMGI_SERVER:-}" ]; then server=("$AMGI_SERVER")
else server=(node ui/server/serve.mjs); fi
pids=()
trap '[ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2> /dev/null' EXIT

# start <var> <line prefix> <command...>: runs it in the background, waits for the line that names
# its URL, and sets <var> to the URL (empty if it never came)
start() {
  local var="$1" prefix="$2" log="$logs/$1.log" n=0
  shift 2
  "$@" > "$log" 2>&1 &
  pids+=($!)
  until grep -q "$prefix" "$log" || [ $n -gt 100 ]; do sleep 0.1; n=$((n + 1)); done
  printf -v "$var" '%s' "$(grep -o "$prefix[^ ]*" "$log" | head -1 | sed "s|^$prefix||")"
  if [ -z "${!var}" ]; then echo "$var did not start: see $log" >&2; exit 1; fi
  case "${!var}" in http*) ;; *) printf -v "$var" 'http://%s' "${!var}" ;; esac
}
# The line an app server says it listens with.
if [ "${AMGI_SERVER:-}" = c ]; then listening='cbase: listening '; else listening='amgi on '; fi
start gemini GEMINI_API_BASE= node plusaudio/test/helpers/fake-gemini.js 0
start app "$listening" env CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY=offline-dummy GEMINI_API_BASE=http://127.0.0.1:9 PORT=0 "${server[@]}"
start keyless "$listening" env CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY= PORT=0 "${server[@]}"
start faked "$listening" env CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY=fake "GEMINI_API_BASE=$gemini" PORT=0 "${server[@]}"
ui/tools/drives.sh cdom "$app" "$keyless" "$faked" "$gemini" "$shots"
