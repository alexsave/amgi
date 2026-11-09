#!/bin/bash
# Builds the C UI into ui/out through ui/Makefile (which owns every rule and flag, on cdom's cdom.mk),
# then says the sizes. Run from anywhere. WASM_CC overrides the wasm compiler (Homebrew's LLVM by
# default), CDOM the cdom checkout (the submodule at cdom/ by default).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
nice -n 10 make -s -j2 -C "$here" all
make -s -C "$here" sizes
