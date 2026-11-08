#!/bin/bash
# Builds the C UI into ui/out: app.wasm, app.css (the components' own CSS files, unchanged, in the
# order the React app loads them), index.html (cdom's shim inlined), wire.wasm (the wire writers for
# the Node server), and natively for ui/test: wire_dump (the app's wire walkers) and text_dump
# (ui/src/text.c and fields.c), and wire_py, which writes anki/addon/amgi_bridge/wire_schema.py.
# Run from anywhere. WASM_CC overrides the compiler (homebrew LLVM by default), CDOM the cdom
# checkout (the submodule at cdom/ by default).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
CC="${WASM_CC:-/opt/homebrew/opt/llvm/bin/clang}"
CDOM="${CDOM:-$root/cdom}"
out="$here/out"
mkdir -p "$out"

WFLAGS=(--target=wasm32 -Oz -nostdlib -ffreestanding -mbulk-memory -Wall -Wextra -Werror)
LFLAGS=(-Wl,--no-entry -Wl,--export-memory -Wl,--stack-first -Wl,-z,stack-size=65536 -Wl,--strip-all)

opt() { # opt <module.wasm>: binaryen's size pass, when it is installed
  if command -v wasm-opt > /dev/null; then
    nice -n 10 wasm-opt -Oz --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
      --enable-nontrapping-float-to-int "$1" -o "$1"
  fi
}
nice -n 10 "$CC" "${WFLAGS[@]}" "${LFLAGS[@]}" -o "$out/wire.wasm" "$here/wire/wire_node.c" "$here/wire/wire.c"
opt "$out/wire.wasm"
nice -n 10 clang -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -Wall -Wextra -Werror \
  -o "$out/wire_dump" "$here/test/wire_dump.c" "$here/wire/wire.c"
nice -n 10 clang -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -Wall -Wextra -Werror -I"$CDOM/src" \
  -o "$out/text_dump" "$here/test/text_dump.c" "$here/src/text.c" "$here/src/fields.c"
# The schema for the Anki bridge add-on's Python (anki/addon/amgi_bridge/bridge_wire.py), written from
# wire.c's table: the add-on holds no layout of its own.
nice -n 10 clang -O1 -Wall -Wextra -Werror -o "$out/wire_py" "$here/wire/wire_py.c" "$here/wire/wire.c"
"$out/wire_py" > "$root/anki/addon/amgi_bridge/wire_schema.py"

nice -n 10 "$CC" "${WFLAGS[@]}" -I"$CDOM/src" "${LFLAGS[@]}" -o "$out/app.wasm" \
  "$here"/src/*.c "$here/wire/wire.c" \
  "$CDOM/src/cdom.c" "$CDOM/src/cdom_net.c" "$CDOM/src/cdom_store.c" "$CDOM/src/cdom_audio.c" "$CDOM/src/cdom_url.c" \
  "$CDOM/src/mini.c"
opt "$out/app.wasm"

# The stylesheet: ui/css's files, kept as the React app's components had them, in the order that app
# loaded them (its layout, its shell, the decks page, settings, the deck page), then the one sheet
# the C UI adds (confirm.css, for the <dialog> that replaced window.confirm).
css=(index.css App.css Navbar.css TemplateUpdate.css DeckItem.css DeckList.css FirstRun.css StarterDeck.css
  Settings.css AudioChip.css BulkRun.css CardForm.css CardPanel.css CardList.css confirm.css)
: > "$out/app.css"
for f in "${css[@]}"; do cat "$here/css/$f" >> "$out/app.css"; printf '\n' >> "$out/app.css"; done

# The page: cdom's shim, minified by cdom itself (shim/cdom.min.js, committed in cdom and checked
# there against cdom.js), inlined. No node on this path: the build is C and the shell's tools.
shim="$CDOM/shim/cdom.min.js"
cp "$shim" "$out/cdom.min.js"
sed -e "/\/\*CDOM_SHIM\*\//{r $out/cdom.min.js" -e "d;}" "$here/src/index.html" > "$out/index.html"

# Sizes, with what brotli makes of them when it is installed.
size() { # size <file>: its bytes, and its brotli size when brotli is there
  local n
  n=$(wc -c < "$1" | tr -d ' ')
  if command -v brotli > /dev/null; then printf '%s bytes, %s brotli' "$n" "$(brotli -c -q 11 "$1" | wc -c | tr -d ' ')"
  else printf '%s bytes' "$n"; fi
}
echo "app.wasm: $(size "$out/app.wasm"); shim, minified by cdom: $(size "$out/cdom.min.js"); index.html $(wc -c < "$out/index.html" | tr -d ' ') bytes"
