#!/bin/sh
# Builds anki/media/_amgi-loop.js out of amgi's own source: make -C anki (the rule is in anki/Makefile).
#
# The Anki template does not get its own copy of the review loop or of the voice detector. It gets
# amgi's, verbatim, with the ES module syntax removed, because an Anki card template is a classic
# script: the reviewer re-runs <script> tags by cloning them into the page (ts/reviewer/index.ts),
# and a module would neither re-execute nor load on clients that serve cards from a non-HTTP origin.
#
# The output is not committed: anki/Makefile rebuilds it from the three sources, and
# tests/anki/build-loop.test.js holds the result to the sources it was built from.
#
# The only import allowed inside the bundle is one shared file reaching for another, which
# concatenation already satisfies. Anything else means the shared code has grown a dependency that
# cannot cross into a card template, and the build stops rather than emit something subtly broken.
#
# usage: build-loop.sh OUTPUT   (run from the repository root)
set -eu
out=$1
shared="src/utils/voiceActivity.js src/utils/reviewLoop.js"
host=anki/src/anki-loop.js

# A shared file as a classic script: `export ` taken off declarations, its allowed import dropped.
# The awk is last so its refusal is the function's status.
classic() {
  sed -E 's/^export[[:space:]]+((const|let|var|function|async|class)([^A-Za-z0-9_]|$))/\1/' "$1" | awk -v file="$1" '
    /^[ \t]*import([^A-Za-z0-9_]|$)/ {
      line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line ~ /^import[ \t]+\{[^}]+\}[ \t]+from[ \t]+\x27\.\/(voiceActivity|reviewLoop)\.js\x27;$/) next
      printf "%s:%d: a card template cannot follow this import: %s\n", file, NR, line > "/dev/stderr"; exit 1
    }
    /^[ \t]*export[ \t]+default([^A-Za-z0-9_]|$)/ || /^[ \t]*export[ \t]*\{/ {
      line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line)
      printf "%s:%d: unsupported export form: %s\n", file, NR, line > "/dev/stderr"; exit 1
    }
    { print }
  '
}

# The text with its leading and trailing whitespace taken off, as a string's trim().
trim() {
  awk '{ l[NR] = $0 } END {
    s = 1; while (s <= NR && l[s] ~ /^[ \t\r]*$/) s++
    e = NR; while (e >= s && l[e] ~ /^[ \t\r]*$/) e--
    for (i = s; i <= e; i++) { x = l[i]; if (i == s) sub(/^[ \t\r]+/, "", x); if (i == e) sub(/[ \t\r]+$/, "", x); print x }
  }'
}

section() { # a source file name, and its code on stdin
  dashes=$((70 - ${#1})); [ "$dashes" -ge 3 ] || dashes=3
  printf '// ---- %s ' "$1"; printf '%*s' "$dashes" '' | tr ' ' '-'; printf '\n\n'; cat
}

tmp=$(mktemp "$out.XXXXXX"); trap 'rm -f "$tmp" "$tmp".*' EXIT
# A refused file stops the build here: a failure inside a pipeline would not (sh has no pipefail).
for f in $shared; do classic "$f" > "$tmp.classic.$(basename "$f")"; done
{
  echo '// GENERATED FILE - do not edit.'
  echo '//'
  echo '// Built by anki/tools/build-loop.sh (make -C anki) from:'
  for f in $shared $host; do echo "//   $f"; done
  echo '//'
  echo '// Not committed: make -C anki builds it.'
  echo '// The leading underscore is deliberate: Anki never reports a media file'
  echo '// whose name starts with one as unused (rslib/src/media/check.rs), and the'
  echo '// quoted "_amgi-loop.js" in the card template is what makes the exporter'
  echo '// carry it into an .apkg (rslib/src/text.rs, UNDERSCORED_REFERENCES).'
  printf "\n(function () {\n'use strict';\n\n"
  first=1
  for f in $shared $host; do
    [ "$first" = 1 ] || printf '\n'; first=0
    if [ "$f" = "$host" ]; then trim < "$f"; else trim < "$tmp.classic.$(basename "$f")"; fi | section "$f"
  done
  printf '\n})();\n'
} > "$tmp"
chmod 644 "$tmp"; mv "$tmp" "$out"; rm -f "$tmp".*; trap - EXIT
