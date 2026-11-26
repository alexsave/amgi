#!/bin/bash
# The Python the Anki-backed tests run under: prints the path of an interpreter that imports
# anki.collection, or says what is missing on stderr and exits 1. npm test runs it first and exports
# the path as ANKI_PYTHON_BIN, so no Anki test is ever skipped for want of the library.
#
#   ANKI_PYTHON_BIN set    that interpreter is used as given (and checked)
#   macOS with Anki.app    Anki.app's own `anki` library (Contents/Resources/app_packages) is built for one
#                          CPython (Contents/Frameworks/Python.framework/Versions/X.Y); a python X.Y is
#                          found on PATH or under uv's python dir, and a venv of it is made in
#                          server/build/anki-venv whose site-packages holds a .pth naming that library:
#                          it needs no environment, so it works under the tests' temp HOMEs and under
#                          python -I (which ignores PYTHONPATH), and it prints server/build/anki-venv/bin/python
#   otherwise              a python3 on PATH that already imports anki
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
venv="$root/server/build/anki-venv"

check() { "$@" -c "import anki.collection" > /dev/null 2>&1; } # check PYTHON [FLAGS]

fail() {
    {
        echo "tests/anki-python.sh: no Python that imports the anki library: $1"
        echo "  The Anki tests must run, never skip. Fix it one of these ways:"
        echo "  - install Anki (https://apps.ankiweb.net) so Anki.app has its library, and a CPython of the version it was built for (uv python install X.Y)"
        echo "  - or set ANKI_PYTHON_BIN to a Python with the library (python3 -m venv .venv && .venv/bin/pip install anki)"
    } >&2
    exit 1
}

if [ -n "${ANKI_PYTHON_BIN:-}" ]; then
    check "$ANKI_PYTHON_BIN" || fail "ANKI_PYTHON_BIN=$ANKI_PYTHON_BIN cannot import anki.collection"
    echo "$ANKI_PYTHON_BIN"
    exit 0
fi

app="${ANKI_APP:-/Applications/Anki.app}"
libs="$app/Contents/Resources/app_packages"
if [ -d "$libs" ]; then
    ver=""
    for d in "$app/Contents/Frameworks/Python.framework/Versions/"*; do
        case "${d##*/}" in [0-9]*.[0-9]*) ver="${d##*/}" ;; esac
    done
    [ -n "$ver" ] || fail "$app has no Frameworks/Python.framework/Versions/X.Y, so its CPython version is unknown"
    candidates=("$(command -v "python$ver" 2> /dev/null || true)")
    for p in "$HOME"/.local/share/uv/python/cpython-"$ver"*/bin/python"$ver"; do
        [ -x "$p" ] && candidates+=("$p")
    done
    for py in "${candidates[@]}"; do
        [ -n "$py" ] && [ -x "$py" ] || continue
        abs="$(cd "$(dirname "$py")" && pwd -P)/$(basename "$py")"
        if PYTHONPATH="$libs" check "$abs"; then
            rm -rf "$venv"
            "$abs" -m venv --without-pip "$venv" || fail "python $abs could not make the venv $venv"
            printf '%s\n' "$libs" > "$venv/lib/python$ver/site-packages/anki-app.pth"
            check "$venv/bin/python" -I || fail "the venv $venv (python $abs, library $libs) cannot import anki.collection under -I"
            echo "$venv/bin/python"
            exit 0
        fi
    done
    fail "$app has its library for CPython $ver, but no working python$ver was found on PATH or under ~/.local/share/uv/python (uv python install $ver)"
fi

py="$(command -v python3 2> /dev/null || true)"
if [ -n "$py" ] && check "$py"; then
    echo "$py"
    exit 0
fi
fail "no $app, and python3 on PATH has no anki"
