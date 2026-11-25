#!/bin/bash
# The amgi command line end to end, as an agent drives it (skills/amgi/SKILL.md), on a throwaway
# collection under a temp HOME: a locked collection refused, up, a second up, install, deck add (twice: find-or-create),
# card add (the manual form: no Gemini), card list, deck list, deck remove (dry run, then --yes), the error exits, down.
#   make build && tests/server/cli-smoke.sh
# The CLI's pid file and log are in AMGI_STATE_DIR (a directory under the sandbox), so this runs
# beside an amgi up from the same checkout without touching it.
# Every process here runs with the temp HOME (tests/e2e/ui/sandbox-home.sh), so nothing can reach a
# real Anki profile. No Gemini call is made: the generate form is only run without a key (exit 5).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
amgi="$root/server/build/amgi"
. "$root/tests/e2e/ui/sandbox-home.sh"
home="$(fresh_home)"
# the CLI's pid file and log go in a directory of this run's own, so an amgi up running from this
# checkout (server/build/amgi.pid) is neither in the way nor touched
state="$sandbox_root/state"
mkdir -p "$state"
pidfile="$state/amgi.pid"
unset CBASE_ENV_FILE GEMINI_API_KEY GEMINI_API_BASE

[ -x "$amgi" ] || { echo "no $amgi: make build first" >&2; exit 1; }

profile="$home/Library/Application Support/Anki2/User 1"
mkdir -p "$profile"
cp -R "$root/tests/server/parity/fixtures/schema18/." "$profile/"
collection="$profile/collection.anki2"

run() { env "HOME=$home" "AMGI_STATE_DIR=$state" "$amgi" "$@"; }
cleanup() { [ -e "$pidfile" ] && run down > /dev/null; rm -rf "$sandbox_root"; }
trap cleanup EXIT

fails=0
# expect <want exit> <a line of stdout must match this extended regex, or -> <command...>
expect() {
  local want="$1" pat="$2"
  shift 2
  out="$(run "$@" 2> "$sandbox_root/err")"
  local rc=$?
  err="$(cat "$sandbox_root/err")"
  if [ "$rc" -ne "$want" ] || { [ "$pat" != - ] && ! printf '%s' "$out" | grep -Eq "$pat"; }; then
    echo "FAIL amgi $*: exit $rc (want $want)"
    echo "  stdout: $out"
    echo "  stderr: $err"
    fails=$((fails + 1))
  else
    echo "ok   amgi $* -> $rc"
    [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/       /'
  fi
}
tab=$'\t'

# Anki has the file (a -wal beside it): up refuses, and leaves nothing running.
touch "$collection-wal"
expect 2 - up --port 0
[ "$err" = "locked: ask the user to close Anki" ] || { echo "FAIL locked line: $err"; fails=$((fails + 1)); }
[ -e "$pidfile" ] && { echo "FAIL a pid file after a refused up"; fails=$((fails + 1)); }
rm -f "$collection-wal"

expect 0 "^amgi up pid=[0-9]+ port=[0-9]+ profile=User 1 collection=" up --port 0
[ "${out#*collection=}" = "$(printf %s "$collection" | tr -s /)" ] || { echo "FAIL up names another collection: $out"; fails=$((fails + 1)); }
pid="$(sed -n 's/^pid\t//p' "$pidfile")"
expect 0 "^amgi up: already running pid=$pid " up
expect 4 - card add --deck Spanish
expect 4 - deck
expect 4 - deck add
expect 0 "^install${tab}yes${tab}yes${tab}" install
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Spanish${tab}-${tab}-\$" deck add Spanish
first="$out"
# deck add is find-or-create: the same name again is the same deck, exit 0, said on stderr
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Spanish${tab}-${tab}-\$" deck add Spanish
[ "$out" = "$first" ] || { echo "FAIL a second deck add is another deck: $first / $out"; fails=$((fails + 1)); }
[ "$err" = "amgi: the deck was already there" ] || { echo "FAIL a second deck add said: $err"; fails=$((fails + 1)); }
expect 0 "^note${tab}[0-9]+${tab}Where is the station\\?${tab}¿Dónde está la estación\\?${tab}-${tab}-\$" \
  card add --deck Spanish --front "Where is the station?" --back "¿Dónde está la estación?" --to es
expect 0 "^note${tab}[0-9]+${tab}Where is the station\\?${tab}" card list --deck Spanish
expect 0 "^deck${tab}[0-9]+${tab}1${tab}Spanish${tab}-${tab}-\$" deck list
expect 3 - card add --deck Nope --front a --back b
expect 3 - card list --deck Nope
expect 5 - card add --deck Spanish --text "Good morning" --from en --to es
case "$err" in *"--key-file"*) ;; *) echo "FAIL the no-key message does not say --key-file: $err"; fails=$((fails + 1)) ;; esac
# card remove: without --yes nothing goes; with it the note is gone; an unknown or malformed ID deletes nothing
expect 0 "^note${tab}[0-9]+${tab}Where is the station" card list --deck Spanish
nid="$(printf '%s' "$out" | cut -f2)"
expect 4 - card remove
expect 4 - card remove abc --yes
expect 4 - card remove -5
expect 3 - card remove 12345 --yes
case "$err" in "amgi: no note 12345 "*"nothing deleted") ;; *) echo "FAIL the unknown-note message: $err"; fails=$((fails + 1)) ;; esac
expect 0 "^would-remove${tab}$nid${tab}Where is the station\\?${tab}¿Dónde está la estación\\?\$" card remove "$nid"
expect 0 "^note${tab}$nid${tab}" card list --deck Spanish
expect 0 "^removed${tab}$nid${tab}Where is the station\\?${tab}¿Dónde está la estación\\?\$" card remove "$nid" --yes
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Spanish${tab}-${tab}-\$" deck list
expect 3 - card remove "$nid" --yes
case "$err" in "amgi: no note $nid "*"nothing deleted") ;; *) echo "FAIL the second remove's message: $err"; fails=$((fails + 1)) ;; esac
expect 0 - card add --deck Spanish --front "Where is the station?" --back "¿Dónde está la estación?" --to es
# a deck's language pair: deck add --from KNOWN --to LEARNING stores it in the deck (and says it), deck list prints it,
# a pair without its other half is a usage error, a code that is not one of the languages is refused with the list
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Hanzi${tab}en${tab}ko\$" deck add Hanzi --from en --to ko
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Hanzi${tab}ko${tab}zh_cn\$" deck add Hanzi --from ko --to zh_cn
[ "$err" = "amgi: the deck was already there" ] || { echo "FAIL a pair on a deck that was there said: $err"; fails=$((fails + 1)); }
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Hanzi${tab}ko${tab}zh_cn\$" deck list
expect 0 "^deck${tab}[0-9]+${tab}1${tab}Spanish${tab}-${tab}-\$" deck list
expect 4 - deck add Hanzi --from en
expect 4 - deck add Hanzi --to ko
expect 4 - deck add Hanzi --from en --to
expect 1 - deck add Hanzi --from en --to xx
case "$err" in *"must each be one of the languages amgi has: en, zh_cn"*) ;; *) echo "FAIL the bad-code message: $err"; fails=$((fails + 1)) ;; esac
expect 1 - deck add Hanzi --from en --to en
case "$err" in *"two different languages"*) ;; *) echo "FAIL the same-code message: $err"; fails=$((fails + 1)) ;; esac
expect 0 "^deck${tab}[0-9]+${tab}0${tab}Hanzi${tab}ko${tab}zh_cn\$" deck list
expect 0 - deck remove Hanzi --yes
# deck remove: without --yes nothing goes; with it the deck is gone; a wrong name and Default delete nothing
expect 0 "^would-remove${tab}[0-9]+${tab}1${tab}1${tab}0${tab}Spanish\$" deck remove Spanish
expect 0 "^deck${tab}[0-9]+${tab}1${tab}Spanish${tab}-${tab}-\$" deck list
expect 3 - deck remove Nope --yes
expect 4 - deck remove Default --yes
expect 0 "^deck${tab}1${tab}" deck list
expect 0 "^removed${tab}[0-9]+${tab}1${tab}1${tab}1${tab}Spanish\$" deck remove Spanish --yes
expect 0 - deck list
printf '%s\n' "$out" | grep -q "${tab}Spanish\$" && { echo "FAIL Spanish is still listed after deck remove --yes"; fails=$((fails + 1)); }
expect 3 - deck remove Spanish
expect 0 "^status${tab}direct${tab}18${tab}$pid${tab}[0-9]+${tab}User 1${tab}" status

expect 0 "^amgi down pid=$pid\$" down
[ -e "$pidfile" ] && { echo "FAIL the pid file is still there"; fails=$((fails + 1)); }
kill -0 "$pid" 2> /dev/null && { echo "FAIL pid $pid is still running"; fails=$((fails + 1)); }
expect 1 - deck list
expect 0 "^amgi down: not running\$" down

[ "$fails" -eq 0 ] && echo "cli-smoke: all passed" || echo "cli-smoke: $fails failed"
[ "$fails" -eq 0 ]
