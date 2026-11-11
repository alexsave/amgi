#!/bin/bash
# Builds a fresh Anki folder for tests/e2e/ui/flows.mjs from the UI fixture (tests/e2e/ui/fixture.sh): one
# profile, "User 1", holding a copy of its collection and media, and no amgi add-ons installed yet.
#   tests/e2e/ui/flows.sh <fixture dir> <new anki folder>
set -euo pipefail
from="$(cd "$1" && pwd)"
to="$2"
rm -rf "$to"
mkdir -p "$to/User 1"
cp "$from/collection.anki2" "$to/User 1/collection.anki2"
cp -R "$from/collection.media" "$to/User 1/collection.media"
[ -f "$from/collection.media.db2" ] && cp "$from/collection.media.db2" "$to/User 1/"
echo "$(cd "$to" && pwd)"
