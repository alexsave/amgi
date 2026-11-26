#!/bin/bash
# The submodules the build needs, cdom (the page) and cbase (the server): checked out when they are
# not (a clone made without --recurse-submodules, or one that pulled a commit adding a submodule), and
# a stop, with the command to run, when a checkout's commit is not the one this repo records (the
# index's: a pin being moved on purpose builds once it is git add-ed). make and npm test run it first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [ ! -d cdom/src ] || [ ! -f cbase/cbase.mk ]; then
    if [ -d .git ] || [ -f .git ]; then
        echo "amgi: checking out the submodules (cdom, cbase): git submodule update --init --recursive" >&2
        git submodule update --init --recursive --quiet
    else
        echo "amgi: cdom/ and cbase/ are missing, and this is not a git checkout: clone with --recurse-submodules" >&2
        exit 1
    fi
fi
if [ -d .git ] || [ -f .git ]; then
    moved="$(git submodule status | awk '$1 ~ /^\+/ {printf "%s%s", sep, $2; sep = " and "}')"
    if [ -n "$moved" ]; then
        case "$moved" in *" and "*) are="are" ;; *) are="is" ;; esac
        printf 'amgi: %s %s not at the commit this repo records. Run:\n\n  git submodule update --init --recursive\n\n' "$moved" "$are" >&2
        exit 1
    fi
fi
