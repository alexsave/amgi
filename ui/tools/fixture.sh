#!/bin/bash
# Builds the UI's fixture collection in <dir> (default .e2e/fixture), from nothing every run: the
# e2e-ui skill's fixture, amgi installed into it, then ui/tools/fixture-extra.py's decks and clips.
# Needs ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG as the e2e-ui skill describes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dir="$(cd "$root" && mkdir -p "${1:-.e2e/fixture}" && cd "${1:-.e2e/fixture}" && pwd)"
cd "$root"
node .claude/skills/e2e-ui/scripts/fixture.js "$dir" > /dev/null
node ui/tools/fixture-install.mjs "$dir"
"$ANKI_PYTHON_BIN" "$here/fixture-extra.py" "$dir/collection.anki2"
echo "$dir/collection.anki2"
