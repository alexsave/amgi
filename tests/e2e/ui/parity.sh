#!/bin/bash
# The UI's parity gate: the shots of a new run against a baseline run of the same drives, to show a
# change moved nothing the page draws. Every PNG in the baseline must match the new one byte for
# byte or, decoded by tests/e2e/ui/compare.mjs, pixel for pixel, and every .html (the DOM each shot also writes, chrome.mjs) must
# be byte-identical. A file missing from either side is a failure. A shot that legitimately changes
# with time is listed in tests/e2e/ui/parity-allow.txt with its reason, and is skipped.
#
#   tests/e2e/ui/parity.sh <baseline shots dir> <new shots dir> [diff dir]
#
# Prints one line per failure; exits 1 when there is any.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
if [ $# -lt 2 ] || [ $# -gt 3 ]; then
    echo "usage: parity.sh <baseline shots dir> <new shots dir> [diff dir]" >&2
    exit 2
fi
base="$(cd "$1" 2>/dev/null && pwd)" || { echo "no baseline folder: $1" >&2; exit 2; }
new="$(cd "$2" 2>/dev/null && pwd)" || { echo "no new folder: $2" >&2; exit 2; }
diffs=""
if [ -n "${3:-}" ]; then
    mkdir -p "$3" && diffs="$(cd "$3" && pwd)" || exit 2
fi
allow="$here/parity-allow.txt"
cd "$root" || exit 2

failed=0
fail() { echo "FAIL $*"; failed=1; }

allowed=" "
while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    file="${line%% *}"
    reason="${line#"$file"}"
    reason="${reason# }"
    if [ -z "$reason" ]; then
        fail "parity-allow.txt: $file has no reason"
        continue
    fi
    allowed="$allowed$file "
done < "$allow"

is_allowed() { case "$allowed" in *" $1 "*) return 0 ;; esac; return 1; }

checked=0
for a in "$base"/*.png "$base"/*.html; do
    [ -e "$a" ] || continue
    f="$(basename "$a")"
    is_allowed "$f" && continue
    checked=$((checked + 1))
    b="$new/$f"
    if [ ! -e "$b" ]; then
        fail "$f is missing from $new"
        continue
    fi
    case "$f" in
    *.png)
        # The same Chrome encodes the same pixels to the same bytes, so equal bytes are the pass. Only a
        # difference is worth decoding: compare.mjs says where and draws it, when sharp is installed.
        cmp -s "$a" "$b" && continue
        out="the pixels differ (bytes differ; install sharp for compare.mjs's where and by how much)"
        if node -e "import('sharp')" > /dev/null 2>&1; then
            d=""
            [ -z "$diffs" ] || d="$diffs/${f%.png}-diff.png"
            out="$(node "$here/compare.mjs" "$a" "$b" "$d" 2>&1)"
            case "$out" in
            0\ of\ *\ pixels\ differ) continue ;; # the bytes differ, the pixels do not (metadata)
            esac
        fi
        fail "$f: $out"
        ;;
    *.html)
        cmp -s "$a" "$b" || fail "$f: the DOM differs (diff $a $b)"
        ;;
    esac
done

# A file only the new side has is as much a difference as one only the baseline has.
for b in "$new"/*.png "$new"/*.html; do
    [ -e "$b" ] || continue
    f="$(basename "$b")"
    is_allowed "$f" && continue
    [ -e "$base/$f" ] || fail "$f is missing from $base"
done

if [ "$checked" -eq 0 ]; then
    fail "no shots in $base"
fi
[ "$failed" -eq 0 ] && echo "parity: $checked files match"
exit "$failed"
