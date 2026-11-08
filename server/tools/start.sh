#!/bin/bash
# The C server, started as npm run start:c starts it: from the repo root (where it reads the page's
# files, the add-ons and the starter deck), listening on CBASE_LISTEN (127.0.0.1:${PORT:-3000} by
# default, the origin the Anki bridge allows out of the box), with .env.local read through cbase's
# CBASE_ENV_FILE when there is one. A missing .env.local is no error, as it is none for the Node
# server: the variable is set only when the file exists. cbase reads the file strictly (KEY=VALUE, no
# blank around '=', one outer pair of quotes stripped; docs/PLATFORM.md 2.10 in cbase), and a line
# that breaks a rule stops the boot with a sentence naming it.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [ -z "${CBASE_ENV_FILE:-}" ] && [ -f .env.local ]; then export CBASE_ENV_FILE="$root/.env.local"; fi
export CBASE_LISTEN="${CBASE_LISTEN:-127.0.0.1:${PORT:-3000}}"
exec "$root/server/build/amgi" serve
