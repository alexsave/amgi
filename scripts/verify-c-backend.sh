#!/bin/bash
# Final verification of amgi's C backend, from a fresh clone, as a new user would get it.
#
#   verify-c-backend.sh <branch-or-sha> [repo-url]
#
# repo-url defaults to https://github.com/alexsave/amgi.git (anonymous https, so a submodule
# still on ssh fails the clone step, as it would for a stranger).
#
# Needs in the environment:
#   ANKI_PYTHON_BIN    a Python with the anki package (npm test, the add-on tests, the fixture)
#   ANKI_FIXTURE_APKG  an .apkg the browser drives import into their fixture
# Optional:
#   VERIFY_WORK        where to clone (default: a new mktemp -d folder, kept for the logs)
#   VERIFY_MAX_LOAD    stop before a step when the 1-minute load is above this (default 30)
#   VERIFY_JOBS        make -j (default 2)
#
# Steps, each PASS or FAIL with its time, logs in $work/logs/<step>.log:
#   clone        git clone, checkout, submodule update --init --recursive
#   check        make -C server check       (cbase's whole check, amgi as its product)
#   check-asan   make -C server check-asan  (the same under ASan and UBSan)
#   npm-test     npm ci, then npm test
#   drives       npm run e2e: the six browser drives against the C server, fixture plus fake Gemini
#   npm-start    npm start on the clone, then GET / and GET /api/anki/status must answer 200
#   real-anki    the real Anki collection's size and mtime are the same after as before
# Exits 0 only when every step passes. A failed step does not stop the later ones, except that
# nothing runs without a clone.
#
# Safety: no real Gemini key ever reaches a step (GEMINI_API_KEY and GEMINI_API_BASE are unset;
# the drives use plusaudio/test/helpers/fake-gemini.js, npm start gets a dummy key and an address
# that refuses). npm start's server gets a throwaway HOME, and /api/anki/status is sent with no
# settings headers, so it answers "unconfigured" and opens no collection and no bridge. Every
# process this script starts is stopped on exit; nothing else is killed.
set -uo pipefail

ref="${1:?usage: verify-c-backend.sh <branch-or-sha> [repo-url]}"
url="${2:-https://github.com/alexsave/amgi.git}"
max_load="${VERIFY_MAX_LOAD:-30}"
jobs="${VERIFY_JOBS:-2}"
work="${VERIFY_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/verify-c-backend.XXXXXX")}"
clone="$work/amgi"
logs="$work/logs"
mkdir -p "$logs"

for v in ANKI_PYTHON_BIN ANKI_FIXTURE_APKG; do
  if [ -z "${!v:-}" ]; then echo "set $v (see .claude/skills/e2e-ui/SKILL.md)" >&2; exit 2; fi
done
unset GEMINI_API_KEY GEMINI_API_BASE CBASE_ENV_FILE CBASE_LISTEN PORT
export ANKI_PYTHON_BIN ANKI_FIXTURE_APKG
# HOME is a throwaway folder for EVERY step. amgi's C server falls back to $HOME/Library/Application
# Support/Anki2 when a request carries no settings header, so a step with the real HOME could open the
# owner's real collection (the 2026-11-08 18:42 corruption made that exposure visible). The real folder
# is only stat'ed by the last step, through REAL_HOME.
REAL_HOME="$HOME"
export npm_config_cache="${npm_config_cache:-$REAL_HOME/.npm}"
mkdir -p "$work/home"
export HOME="$work/home"

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    # npm start ends in exec of server/build/amgi; stop that and anything left under the npm.
    pkill -TERM -P "$server_pid" 2> /dev/null
    kill -TERM "$server_pid" 2> /dev/null
    for p in $(pgrep -f "$clone/server/build/amgi serve"); do kill -TERM "$p" 2> /dev/null; done
  fi
}
trap cleanup EXIT

results=()
failed=0
load1() { sysctl -n vm.loadavg | awk '{print int($2)}'; }

# step <name> <function>: runs it niced, logs it, prints PASS/FAIL with its time.
step() {
  local name="$1" fn="$2" start rc
  local l
  l="$(load1)"
  if [ "$l" -gt "$max_load" ]; then
    echo "STOP  $name: 1-minute load $l is above $max_load; nothing more runs" >&2
    results+=("STOP  $name (load $l)")
    failed=1
    summary
    exit 1
  fi
  printf '...   %s (log %s)\n' "$name" "$logs/$name.log"
  start=$(date +%s)
  "$fn" > "$logs/$name.log" 2>&1
  rc=$?
  local secs=$(($(date +%s) - start))
  local verdict
  if [ $rc -eq 0 ]; then
    verdict="$(printf 'PASS  %-10s %4ds' "$name" "$secs")"
    results+=("$verdict")
  else
    verdict="$(printf 'FAIL  %-10s %4ds  exit %d, last lines:' "$name" "$secs" "$rc")"
    results+=("$verdict")
    while IFS= read -r line; do results+=("        $line"); done < <(tail -5 "$logs/$name.log")
    failed=1
  fi
  echo "$verdict"
  return $rc
}

summary() {
  echo
  echo "verify-c-backend: $ref from $url, in $work"
  printf '%s\n' "${results[@]}"
  if [ $failed -eq 0 ]; then echo "ALL PASS"; else echo "SOME STEP FAILED"; fi
}

# The real collection, looked at (stat only, never opened) before and after.
real_anki="$REAL_HOME/Library/Application Support/Anki2"
anki_fingerprint() {
  find "$real_anki" -maxdepth 2 -name 'collection.anki2*' -exec stat -f '%N %z %m' {} \; 2> /dev/null | sort
}
anki_before="$(anki_fingerprint)"

s_clone() {
  git clone --recurse-submodules "$url" "$clone" &&
    git -C "$clone" checkout --detach "$ref" &&
    git -C "$clone" submodule update --init --recursive &&
    git -C "$clone" log -1 --format='%H %s' &&
    git -C "$clone" submodule status
}
s_check() { cd "$clone" && nice -n 10 make -j"$jobs" -C server check; }
s_check_asan() { cd "$clone" && nice -n 10 make -j"$jobs" -C server check-asan; }
s_npm_test() { cd "$clone" && nice -n 10 npm ci --no-audit --no-fund && nice -n 10 npm test; }
s_drives() {
  # ui/tools/e2e.sh starts the fake Gemini and three C servers on free ports, and builds nothing
  # itself: npm run e2e builds the page and the server first. The fixture is made here.
  # Chrome must not run under the throwaway HOME: it has no ~/Library/Keychains there and macOS pops a
  # keychain dialog at the owner. So Chrome gets the real HOME, and only the servers get a temp one,
  # which e2e.sh must set itself (env HOME=... on the server start lines). Refuse to run otherwise,
  # because a server under the real HOME could reach the real Anki2 folder.
  if ! grep -q 'HOME=' "$clone/ui/tools/e2e.sh"; then
    echo "ui/tools/e2e.sh does not give the servers their own HOME; not running the drives under the real HOME" >&2
    return 1
  fi
  cd "$clone" && nice -n 10 npm run build && nice -n 10 ui/tools/fixture.sh && HOME="$REAL_HOME" nice -n 10 npm run e2e
}
s_npm_start() {
  cd "$clone" || return 1
  local home="$work/home" log="$logs/npm-start.server.log" port="" n=0
  mkdir -p "$home"
  # Port 0: cbase picks a free one and names it in its startup line.
  env HOME="$home" CBASE_LISTEN=127.0.0.1:0 GEMINI_API_KEY=offline-dummy GEMINI_API_BASE=http://127.0.0.1:9 \
    nice -n 10 npm start > "$log" 2>&1 &
  server_pid=$!
  until port="$(grep -o 'cbase: listening [^ ]*' "$log" | head -1 | sed 's/.*://')" && [ -n "$port" ] || [ "$n" -gt 600 ]; do
    if ! kill -0 "$server_pid" 2> /dev/null; then echo "npm start exited before listening:"; cat "$log"; return 1; fi
    sleep 1; n=$((n + 1))
  done
  if [ -z "$port" ]; then echo "no 'cbase: listening' line after 600 s:"; cat "$log"; return 1; fi
  echo "listening on 127.0.0.1:$port"
  local page status
  page="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")"
  status="$(curl -s -o "$work/status.bin" -w '%{http_code} %{content_type}' "http://127.0.0.1:$port/api/anki/status")"
  echo "GET / -> $page"
  echo "GET /api/anki/status -> $status ($(wc -c < "$work/status.bin" | tr -d ' ') bytes)"
  cleanup
  server_pid=""
  [ "$page" = 200 ] && case "$status" in "200 application/x-amgi-wire"*) true ;; *) false ;; esac
}
s_real_anki() {
  local after
  after="$(anki_fingerprint)"
  echo "before:"; echo "$anki_before"; echo "after:"; echo "$after"
  [ "$anki_before" = "$after" ]
}

if step clone s_clone; then
  step check s_check
  step check-asan s_check_asan
  step npm-test s_npm_test
  step drives s_drives
  step npm-start s_npm_start
fi
step real-anki s_real_anki
summary
exit $failed
