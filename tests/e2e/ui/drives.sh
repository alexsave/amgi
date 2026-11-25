#!/bin/bash
# Every browser drive of the UI, one Chrome at a time, each on a fresh copy of the UI fixture
# (tests/e2e/ui/fixture.sh first): shoot.mjs (the screens and the back button), flows.mjs (first run,
# new deck, card design notice, install, starter deck), edit.mjs (editing, deleting, renaming),
# languages.mjs (a deck's languages: stored, found, picked, changed), deckdelete.mjs (deleting a deck: Default, subdecks, counts, locked, already gone) and
# bulk.mjs (making cards against the fake Gemini), limits.mjs (text too long for a box, refused
# with a message) and states.mjs (the decks screen in each setup
# state; it needs ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG, as the e2e-ui skill sets them). Prints each drive's checks and failures; exits 1
# when any failed.
#
#   tests/e2e/ui/drives.sh <name> <app url> <no-key app url> <fake-gemini app url> <fake gemini url> <shots dir>
#
# AMGI_E2E_WORK sets the folder the drives copy the fixture into (default <repo>/.e2e/drives). A screen can
# show that path (the Anki folder), so parity runs set it: both runs show the same paths.
#
# The three app servers differ only in their Gemini key: one with any key (the screens), one with
# none (the starter deck is offered), one pointed at the fake (node tests/server/plusaudio/helpers/fake-gemini.js
# <port>, whose limits the bulk drive switches). Start the fake and its server fresh before a run:
# the fake's "broken line" fails once, and a server's rate gate remembers the limits it met.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
name="$1" app="$2" keyless="$3" faked="$4" gemini="$5" shots="$6"
# One place for both apps (gitignored), so a path a screen shows is the same in both shots.
work="${AMGI_E2E_WORK:-$root/.e2e/drives}"
mkdir -p "$work"
cd "$root"
. "$here/sandbox-home.sh"
fresh() { # fresh <folder> [installed]: the fixture as one profile, "User 1", amgi installed or not
  local dir
  dir=$(tests/e2e/ui/flows.sh .e2e/fixture "$work/$1")
  if [ "${2:-}" = installed ]; then node tests/e2e/ui/fixture-install.mjs "$dir" > /dev/null; fi
  echo "$dir"
}
failed=0
run() { # run <drive> <args...>; DRIVES="languages edit" runs only those
  local drive="$1"; shift
  case " ${DRIVES:-$drive} " in *" $drive "*) ;; *) return 0 ;; esac
  local log="$work/$drive.log"
  node "tests/e2e/ui/$drive.mjs" "$@" > "$log" 2>&1 || failed=1
  echo "$drive: $(grep -c '^ok' "$log") ok"
  grep -v '^ok' "$log"
}
# shoot reads the fixture folder in place and a screen shows its path, so it gets a copy under $work too
rm -rf "$work/shoot"; cp -R .e2e/fixture "$work/shoot"
run shoot "$app" "$name" "$work/shoot/collection.anki2" "$shots"
run flows "$app" "$keyless" "$name" "$(fresh flows)" "$shots"
run edit "$app" "$name" "$(fresh edit installed)" "$shots"
run deckdelete "$app" "$name" "$(fresh deckdelete installed)" "$shots"
run bulk "$faked" "$gemini" "$name" "$(fresh bulk installed)" "$shots"
run languages "$faked" "$gemini" "$name" "$(fresh languages installed)" "$shots"
run limits "$app" "$name" "$(fresh limits installed)" "$shots"
run states "$app" "$name" "$work" "$shots"
exit $failed
