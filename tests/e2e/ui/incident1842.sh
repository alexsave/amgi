#!/bin/bash
# Incident 18:42 end to end, one command: builds what it needs (the page, the server, the Anki
# stand-in), makes a fresh temp folder for the server's and the stand-in's HOME, runs
# tests/e2e/ui/incident1842.mjs with it and deletes it after. The collection is a copy in that folder of
# the repo's own fixture; no real Anki folder is read or written.
#
#   tests/e2e/ui/incident1842.sh        (ANKI_PYTHON_BIN, when set, adds the anki library's Check Database)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
cd "$root"
if [ "${INCIDENT1842_NO_BUILD:-}" != 1 ]; then
  server/tools/submodules.sh || exit 1
  ui/build.sh > /dev/null || exit 1
  make -s -C server build/amgi build/anki_standin || exit 1
fi
home="$(mktemp -d "${TMPDIR:-/tmp}/amgi-incident1842-XXXXXX")"
home="$(cd "$home" && pwd -P)"
real="$(cd ~ && pwd -P)"
if [ "$home" = "$real" ] || [ -z "$home" ]; then echo "incident1842: the temp HOME is the real one" >&2; exit 2; fi
trap 'rm -rf "$home"' EXIT
node "$here/incident1842.mjs" "$home"
