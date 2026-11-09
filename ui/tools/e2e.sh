#!/bin/bash
# Every browser drive against fresh servers: the fake Gemini and the three app servers it needs
# (any key, no key, pointed at the fake), each on a free port, started here and stopped on exit,
# so a run never meets another run's rate gate or the fake's spent "broken line". Then
# ui/tools/drives.sh. Build first (ui/build.sh) and make the fixture (ui/tools/fixture.sh).
#
#   ui/tools/e2e.sh [shots dir]        (default .e2e/shots)
#
# The app servers are the C server (server/build/amgi serve, on cbase; make -C server builds it),
# each asked for a free port (CBASE_LISTEN=127.0.0.1:0) and ready once cbase's startup line,
# "cbase: listening <host:port>", names it.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
. "$here/sandbox-home.sh"
shots="${1:-$root/.e2e/shots}"
logs="$root/.e2e/servers"
mkdir -p "$shots" "$logs"
# states.mjs builds collections of its own, as ui/tools/fixture.sh does.
for v in ANKI_PYTHON_BIN ANKI_FIXTURE_APKG; do
  if [ -z "${!v:-}" ]; then echo "set $v (see the e2e-ui skill)" >&2; exit 1; fi
done
server=("$root/server/build/amgi" serve)
pids=()
trap '[ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2> /dev/null; rm -rf "$sandbox_root"' EXIT

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
listening='cbase: listening '
start gemini GEMINI_API_BASE= env "HOME=$(fresh_home)" node plusaudio/test/helpers/fake-gemini.js 0
start app "$listening" env "HOME=$(fresh_home)" CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY=offline-dummy GEMINI_API_BASE=http://127.0.0.1:9 "${server[@]}"
start keyless "$listening" env "HOME=$(fresh_home)" CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY= "${server[@]}"
start faked "$listening" env "HOME=$(fresh_home)" CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY=fake "GEMINI_API_BASE=$gemini" "${server[@]}"
ui/tools/drives.sh cdom "$app" "$keyless" "$faked" "$gemini" "$shots"
