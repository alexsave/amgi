#!/bin/bash
# The submodules the build needs, cdom (the page) and cbase (the server): checked out when they are
# not (a clone made without --recurse-submodules, or one that pulled a commit adding a submodule), and
# a clear sentence when a checkout's commit is not the one this repo records. npm start, dev, test and
# e2e run it first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [ ! -d cdom/src ] || [ ! -f cbase/cbase.mk ]; then
  if [ -d .git ] || [ -f .git ]; then
    echo "amgi: checking out the submodules (cdom, cbase): git submodule update --init --recursive" >&2
    git submodule update --init --recursive
  else
    echo "amgi: cdom/ and cbase/ are missing, and this is not a git checkout: clone with --recurse-submodules" >&2
    exit 1
  fi
fi
if [ -d .git ] || [ -f .git ]; then
  moved="$(git submodule status | awk '$1 ~ /^\+/ {print $2}')"
  if [ -n "$moved" ]; then
    echo "amgi: the submodule(s) $moved are checked out at another commit than this repo records; after a pull, run: git submodule update --init --recursive" >&2
  fi
fi
