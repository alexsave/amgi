# amgi's native code, on cbase (the submodule at ../cbase) through cbase.mk:
#   - server/app: the amgi app on cbase serve (build/amgi): the cb_app over server/amgi, its routes,
#     install, the starter deck, the rate gate and Gemini (server/amgi/amgi.h).
#   - server/collection and server/json: the collection core (the C port of plusaudio/lib/collection,
#     the direct transport and the bridge client) and its Anki JSON quarantine, as one library with
#     its own flags and its own gates (test/no-json.test.mjs, the random scan, server/test/unit.c).
#     It is APP_EXTRA_SRC, not a source root, because it carries JavaScript's number semantics
#     (strtod for JSON numbers and Number()), which cbase's number gate refuses in a product root.
#   - test/parity/dump.c: the collection-parity dump tool (no cbase in it).
#
#   make -C server                    build/amgi, build/collection_cli, build/parity_dump, build/difftest
#   make -C server check-collection   the C collection core's own tests (server/test/unit.c), under ASan
#   make -C server build/asan/collection_cli   the collection CLI under ASan and UBSan
#   make -C server check              cbase's whole check, with the amgi app as its product
#
# sqlite is upstream's on every platform: on macOS Homebrew's, as cbase.mk resolves it. ICU is the
# one Node is built with (process.versions.icu, 78 today), so case folding, NFC and script lookups
# answer exactly as the Node code they replace did: on macOS Homebrew's icu4c@78.
CBASE := ../cbase
C_ROOT := ..
CBASE_PROVIDERS := local
APP_SERVE := amgi
APP_SRC_ROOTS := app
ICU_MAJOR ?= 78
ifeq ($(shell uname -s),Darwin)
  ICU_PREFIX ?= $(shell brew --prefix icu4c@$(ICU_MAJOR) 2>/dev/null)
  ifeq ($(wildcard $(ICU_PREFIX)/include/unicode/uchar.h),)
    $(error no Homebrew ICU $(ICU_MAJOR) (ICU_PREFIX='$(ICU_PREFIX)'): brew install icu4c@$(ICU_MAJOR))
  endif
endif
comma := ,
ICU_CFLAGS := $(if $(ICU_PREFIX),-I$(ICU_PREFIX)/include)
ICU_LDFLAGS := $(if $(ICU_PREFIX),-L$(ICU_PREFIX)/lib -Wl$(comma)-rpath$(comma)$(ICU_PREFIX)/lib)
WARN := -Wall -Wextra -Werror -Wshadow -Wvla -std=gnu11 -D_GNU_SOURCE -D_DARWIN_C_SOURCE

COL_SRC := collection/util.c collection/rng.c collection/db.c collection/backup.c collection/text.c collection/pb.c \
  collection/decks.c collection/notes.c collection/media.c collection/direct.c json/anki_json.c json/model_answer.c
# The bridge client and resolveTransport: the half that speaks HTTP, through cbase's client.
BRIDGE_SRC := collection/bridge.c collection/transport.c collection/wire_host.c ../ui/wire/wire.c
COL_HDR := $(wildcard collection/*.h json/*.h) ../ui/wire/wire.h
# The amgi app's own code (server/amgi/amgi.h): its routes, install, the starter deck, the rate gate and
# Gemini. A product library like the core, for the same reason: it reads numbers as JavaScript does.
AMGI_SRC := $(sort $(wildcard amgi/*.c))
APP_EXTRA_SRC := $(COL_SRC) $(BRIDGE_SRC) $(AMGI_SRC)
APP_EXTRA_CFLAGS = $(WARN) -O2 -g -pthread -I$(CBASE)/core/include -I$(CBASE)/core/src -I$(CBASE)/lib -I../ui/wire \
  $(ICU_CFLAGS) $(SQLITE_CFLAGS) $(OPENSSL_CFLAGS)
APP_LDLIBS := $(ICU_LDFLAGS) -licui18n -licuuc
APP_PROGS := collection_cli=collection/cli.c
include $(CBASE)/cbase.mk

# The ones not linked with cbase: the dump tool, and the core's own tests, under the sanitizers.
NATIVE_CFLAGS = $(WARN) -g -pthread $(ICU_CFLAGS) $(SQLITE_CFLAGS) $(OPENSSL_CFLAGS)
NATIVE_SAN := -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
NATIVE_LIBS = $(ICU_LDFLAGS) $(SQLITE_LDFLAGS) $(OPENSSL_LDFLAGS) \
  $(if $(SQLITE_PREFIX),-Wl$(comma)-rpath$(comma)$(SQLITE_PREFIX)/lib) $(if $(OPENSSL_PREFIX),-Wl$(comma)-rpath$(comma)$(OPENSSL_PREFIX)/lib) \
  -lsqlite3 -licui18n -licuuc -lcrypto -lpthread

all: build/parity_dump build/difftest

build/parity_dump: ../test/parity/dump.c
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -O2 -o $@ $< $(NATIVE_LIBS)

# The C side of test/parity/difftest.test.mjs (removed at L4).
build/difftest: $(COL_SRC) test/difftest.c $(COL_HDR)
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) $(NATIVE_SAN) -o $@ $(COL_SRC) test/difftest.c $(NATIVE_LIBS)

# Tests of the C itself (server/test/unit.c).
build/unit: $(COL_SRC) collection/wire_host.c test/unit.c $(COL_HDR)
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) $(NATIVE_SAN) -I../ui/wire -o $@ $(COL_SRC) collection/wire_host.c test/unit.c $(NATIVE_LIBS)

# Tests of the backup (server/test/backup_unit.c), which includes collection/backup.c to reach its fault points.
build/backup_unit: $(COL_SRC) test/backup_unit.c $(COL_HDR)
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) $(NATIVE_SAN) -o $@ $(filter-out collection/backup.c,$(COL_SRC)) test/backup_unit.c $(NATIVE_LIBS)

# The media folder's own tests (server/test/media_unit.c), media.c built with its fault seam.
build/media_unit: $(COL_SRC) test/media_unit.c $(COL_HDR)
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) $(NATIVE_SAN) -DMEDIA_FAULTS -o $@ $(COL_SRC) test/media_unit.c $(NATIVE_LIBS)

check-collection: build/unit build/backup_unit build/media_unit
	build/unit $(CURDIR)/..
	build/backup_unit $(CURDIR)/..
	build/media_unit

# The collection CLI under ASan and UBSan, linked with cbase's sanitized build.
$(call prog,build/asan,build/obj/asan,build/obj/asan-extra,collection_cli,collection/cli.c,ASAN_CB_CFLAGS)

.PHONY: check-collection
