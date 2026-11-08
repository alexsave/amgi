#!/bin/bash
# Builds the C UI into ui/out: app.wasm, app.css (the components' own CSS files, unchanged, in the
# order the React app loads them), index.html (cdom's shim inlined), wire.wasm (the wire writers for
# the Node server), and natively for ui/test: wire_dump (the app's wire walkers) and text_dump
# (ui/src/text.c and fields.c).
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

# The page: the shim minified and inlined.
"$root/node_modules/.bin/terser" "$CDOM/shim/cdom.js" -c passes=2 -m -o "$out/cdom.min.js"
sed -e "/\/\*CDOM_SHIM\*\//{r $out/cdom.min.js" -e "d;}" "$here/src/index.html" > "$out/index.html"

printf 'app.wasm: %s bytes, %s brotli; shim: %s bytes minified, %s brotli; index.html %s bytes\n' \
  "$(wc -c < "$out/app.wasm" | tr -d ' ')" "$(brotli -c -q 11 "$out/app.wasm" | wc -c | tr -d ' ')" \
  "$(wc -c < "$out/cdom.min.js" | tr -d ' ')" "$(brotli -c -q 11 "$out/cdom.min.js" | wc -c | tr -d ' ')" \
  "$(wc -c < "$out/index.html" | tr -d ' ')"
