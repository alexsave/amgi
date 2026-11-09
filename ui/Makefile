# The C UI, built into ui/out on cdom's make fragment (cdom.mk, the submodule at ../cdom):
#   out/app.wasm      the page's module: src/*.c and wire/wire.c on cdom with its net, store, audio
#                     and url modules, through cdom.mk's APP_WASM rule, then binaryen's size pass
#                     (wasm-opt) when it is installed
#   out/index.html    src/index.html with cdom's minified shim inlined (cdom.mk's APP_PAGE rule)
#   out/app.css       css/'s files, kept as the React app's components had them, in the order that
#                     app loaded them (its layout, its shell, the decks page, settings, the deck
#                     page), then the one sheet the C UI adds (confirm.css, for the <dialog> that
#                     replaced window.confirm)
#   out/wire.wasm     the wire writers for the Node tests and tools (wire/wire_node.c, no cdom code)
#   out/wire_dump, out/text_dump   natively, under ASan and UBSan, for ui/test: the app's wire
#                     walkers, and src/text.c with src/fields.c
#   out/wire_py       writes ../anki/addon/amgi_bridge/wire_schema.py from wire.c's table, so the
#                     Anki bridge add-on holds no layout of its own
#
#   make -C ui        all of it (ui/build.sh runs this, then says the sizes)
#   make -C ui sizes  the sizes of app.wasm, the shim and index.html, with brotli's when installed
#
# CDOM moves the cdom checkout and WASM_CC the wasm compiler (cdom.mk: Homebrew's LLVM by default).
# No Node on this path: make, awk and clang.
CDOM ?= ../cdom
ifeq ($(wildcard $(CDOM)/cdom.mk),)
  $(error the cdom submodule is not checked out (ui/../cdom): git submodule update --init --recursive)
endif
OUT := out
HOST_CC ?= clang
WARN := -Wall -Wextra -Werror
SAN := -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all
SCHEMA := ../anki/addon/amgi_bridge/wire_schema.py
CSS := index.css App.css Navbar.css TemplateUpdate.css DeckItem.css DeckList.css FirstRun.css StarterDeck.css \
  Settings.css AudioChip.css BulkRun.css CardForm.css CardPanel.css CardList.css confirm.css

all: $(OUT)/app.wasm $(OUT)/index.html $(OUT)/app.css $(OUT)/wire.wasm $(OUT)/wire_dump $(OUT)/text_dump $(OUT)/am_decode_test $(SCHEMA)

# The shipped UI strings are obfuscated so `strings app.wasm` no longer reads the app's text. Before
# the compile, ui/tools/textgen.c reads src/*.c, turns every CD_LIT(...)/AM_Z(...) into an id lookup
# in out/gen/<file>, and emits out/gen/am_blob.c (the one XOR-obfuscated blob, and am_s/am_z over it).
# cdom.mk compiles the out/gen copies, not src/, so the module carries no plaintext UI text while the
# sources keep their readable strings. The key is fixed, so the blob is reproducible. See src/am_text.h.
GEN := $(OUT)/gen
SRCS := $(sort $(wildcard src/*.c))
GEN_SRCS := $(patsubst src/%,$(GEN)/%,$(SRCS)) $(GEN)/am_blob.c

# The module as cdom.mk links it, before the size pass.
APP_WASM := $(OUT)/raw/app.wasm
APP_SRC := $(GEN_SRCS) wire/wire.c
APP_MODULES := net store audio url
# -Isrc: the out/gen copies #include "app.h" from src/.
APP_CFLAGS := $(WARN) -Isrc
APP_LDFLAGS := -Wl,--strip-all
APP_PAGE := $(OUT)/index.html
APP_PAGE_SRC := src/index.html
# The page loads /app.wasm by URL (the server serves it), so the module stays its own file.
APP_WASM_SEPARATE := 1
include $(CDOM)/cdom.mk

# cdom.mk's rule knows cdom's headers; these are the app's own.
APP_HDR := $(wildcard src/*.h) wire/wire.h
$(APP_WASM): $(APP_HDR)

# textgen and the generated sources. One run writes every out/gen file, so a stamp stands in for the
# group (GNU make 3.81 has no grouped targets); the sources depend on it.
$(OUT)/textgen: tools/textgen.c
	@mkdir -p $(@D)
	$(HOST_CC) -O1 $(WARN) -o $@ tools/textgen.c

GEN_STAMP := $(GEN)/.textgen.stamp
$(GEN_STAMP): $(OUT)/textgen $(SRCS) $(APP_HDR)
	@mkdir -p $(GEN)
	$(OUT)/textgen $(GEN) src/app.h $(SRCS)
	@touch $@
$(GEN_SRCS): $(GEN_STAMP)

# The blob's XOR decode is lossless: every string decodes back to its original (am_check.h's plaintext).
$(OUT)/am_decode_test: test/am_decode_test.c $(GEN_STAMP)
	@mkdir -p $(@D)
	$(HOST_CC) $(SAN) $(WARN) -I$(GEN) -o $@ test/am_decode_test.c

# wasm-opt <in> <out>: binaryen's size pass when it is installed, a copy when it is not.
wasm_opt = if command -v wasm-opt > /dev/null; then \
    wasm-opt -Oz --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
      --enable-nontrapping-float-to-int $(1) -o $(2); \
  else cp $(1) $(2); fi

$(OUT)/app.wasm: $(APP_WASM)
	$(call wasm_opt,$<,$@)

# wire.wasm links no C library at all (not even cdom's mini.c), so it is built -ffreestanding: without
# it clang turns its loops into calls to strlen, which nothing defines.
$(OUT)/raw/wire.wasm: wire/wire_node.c wire/wire.c wire/wire.h $(CDOM)/cdom.mk
	@mkdir -p $(@D)
	$(WASM_CC) $(CDOM_OPT) $(CDOM_CFLAGS) -ffreestanding $(WARN) $(CDOM_LDFLAGS) -Wl,--strip-all -o $@ wire/wire_node.c wire/wire.c

$(OUT)/wire.wasm: $(OUT)/raw/wire.wasm
	$(call wasm_opt,$<,$@)

# cssmin strips the authored /* ... */ comments (the old React component notes) out of the shipped
# app.css, so the stylesheet carries none while css/ keeps them. It respects strings, so content and
# url() are untouched.
$(OUT)/cssmin: tools/cssmin.c
	@mkdir -p $(@D)
	$(HOST_CC) -O1 $(WARN) -o $@ tools/cssmin.c

$(OUT)/app.css: $(addprefix css/,$(CSS)) $(OUT)/cssmin
	@mkdir -p $(@D)
	{ for f in $(addprefix css/,$(CSS)); do cat $$f; printf '\n'; done; } | $(OUT)/cssmin > $@.tmp && mv $@.tmp $@

# cdom ships its shim minified but with a leading `// GENERATED ...` line comment; drop the shim's
# line comments so the shim inlined into index.html carries none. cdom is not forked: this is a copy
# we inline in its place (CDOM_SHIM override, below).
STRIPPED_SHIM := $(OUT)/cdom.min.stripped.js
CDOM_SHIM := $(STRIPPED_SHIM)
$(STRIPPED_SHIM): $(CDOM)/shim/cdom.min.js
	@mkdir -p $(@D)
	awk '!/^[ \t]*\/\//' $< > $@.tmp && mv $@.tmp $@

$(OUT)/wire_dump: test/wire_dump.c wire/wire.c wire/wire.h
	@mkdir -p $(@D)
	$(HOST_CC) $(SAN) $(WARN) -o $@ test/wire_dump.c wire/wire.c

$(OUT)/text_dump: test/text_dump.c src/text.c src/fields.c $(APP_HDR) $(CDOM_HEADERS)
	@mkdir -p $(@D)
	$(HOST_CC) $(SAN) $(WARN) -I$(CDOM)/src -o $@ test/text_dump.c src/text.c src/fields.c

$(OUT)/wire_py: wire/wire_py.c wire/wire.c wire/wire.h
	@mkdir -p $(@D)
	$(HOST_CC) -O1 $(WARN) -o $@ wire/wire_py.c wire/wire.c

$(SCHEMA): $(OUT)/wire_py
	$(OUT)/wire_py > $@.tmp && mv $@.tmp $@

# size <file>: its bytes, and its brotli size when brotli is installed.
size = n=$$(wc -c < $(1) | tr -d ' '); \
  if command -v brotli > /dev/null; then printf '%s bytes, %s brotli' $$n $$(brotli -c -q 11 $(1) | wc -c | tr -d ' '); \
  else printf '%s bytes' $$n; fi
sizes: $(OUT)/app.wasm $(OUT)/index.html
	@printf 'app.wasm: '; $(call size,$(OUT)/app.wasm); printf '; shim, minified by cdom: '; \
	  $(call size,$(CDOM_SHIM)); printf '; index.html %s bytes\n' $$(wc -c < $(OUT)/index.html | tr -d ' ')

.PHONY: all sizes
