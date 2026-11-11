# amgi's native code, on cbase (the submodule at ../cbase) through cbase.mk:
#   - server/app: the amgi app on cbase serve (build/amgi-serve): the cb_app over server/amgi, its routes,
#     install, the starter deck, the rate gate and Gemini (server/amgi/amgi.h).
#   - server/cli: build/amgi, the one binary people and agents run: `amgi serve` is the same server
#     as build/amgi-serve, and its other words (up, down, deck, card, ...) are the command line, a
#     loopback client of that server (server/cli/amgi.c). cbase's serve binary stays cbase's own
#     main (its smoke holds it to cbase's usage), so the command line is a program of its own.
#   - server/collection and server/json: the collection core (the C port of what was plusaudio/lib/collection,
#     the direct transport and the bridge client) and its Anki JSON quarantine, as one library with
#     its own flags and its own gates (test/no-json.test.mjs, the random scan, server/test/unit.c).
#     It is APP_EXTRA_SRC, not a source root, because it carries JavaScript's number semantics
#     (strtod for JSON numbers and Number()), which cbase's number gate refuses in a product root.
#   - tests/server/parity/dump.c: the collection-parity dump tool (no cbase in it).
#   - server/cli/clip.c: build/amgi-clip, one clip for a caller that is not C (the add-on's Fill missing
#     audio): card_generate_audio in process, the contract of plusaudio/generate-clip.js.
#
#   make -C server                    build/amgi, build/amgi-serve, build/amgi-clip, build/collection_cli, build/app_unit, build/parity_dump
#   make -C server check-collection   the C collection core's own tests (server/test/unit.c), under ASan
#   make -C server build/asan/collection_cli   the collection CLI under ASan and UBSan
#   make -C server check              cbase's whole check, with the amgi app as its product
#   make -C server serve              build/amgi-serve, then serve from the repository root (cbase.mk's
#                                     make serve: CBASE_LISTEN, or PORT, moves it from 127.0.0.1:3000;
#                                     .env.local, when it is there, is read as CBASE_ENV_FILE)
#
# sqlite is upstream's on every platform: on macOS Homebrew's, as cbase.mk resolves it. ICU is the
# one Node is built with (process.versions.icu, 78 today), so case folding, NFC and script lookups
# answer exactly as the Node code they replace did: on macOS Homebrew's icu4c@78.
CBASE := ../cbase
ifeq ($(wildcard $(CBASE)/cbase.mk),)
  $(error the cbase submodule is not checked out (server/../cbase): git submodule update --init --recursive)
endif
C_ROOT := ..
CBASE_PROVIDERS := local
APP_SERVE := amgi-serve
# serve runs from the repository root, where it reads the page's files (ui/out), the add-ons and the
# starter deck, and finds .env.local (cbase.mk's APP_ENV_FILE default).
APP_SERVE_DIR := ..
APP_SRC_ROOTS := app
# wire.h, for the tests that include the app's headers (test/app_unit.c)
APP_INC := -I../ui/wire
ICU_MAJOR ?= 78
ifeq ($(shell uname -s),Darwin)
  OPENSSL_PREFIX ?= $(shell brew --prefix openssl@3 2>/dev/null)
  ifeq ($(wildcard $(OPENSSL_PREFIX)/include/openssl/evp.h),)
    $(error no Homebrew OpenSSL 3 (OPENSSL_PREFIX='$(OPENSSL_PREFIX)'): brew install openssl@3)
  endif
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
SERVER_LDFLAGS := $(ICU_LDFLAGS) -licui18n -licuuc
APP_PROGS := amgi=cli/amgi.c amgi-clip=cli/clip.c collection_cli=collection/cli.c app_unit=test/app_unit.c golden_cards=test/golden_cards.c
# cbase's own default port is 8642; amgi keeps 3000 (PORT, or CBASE_LISTEN, moves it).
APP_SERVE_LISTEN := 127.0.0.1:$(or $(PORT),3000)
include $(CBASE)/cbase.mk

# The ones not linked with cbase: the dump tool, and the core's own tests, under the sanitizers.
NATIVE_CFLAGS = $(WARN) -g -pthread $(ICU_CFLAGS) $(SQLITE_CFLAGS) $(OPENSSL_CFLAGS)
NATIVE_SAN := -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
NATIVE_LIBS = $(ICU_LDFLAGS) $(SQLITE_LDFLAGS) $(OPENSSL_LDFLAGS) \
  $(if $(SQLITE_PREFIX),-Wl$(comma)-rpath$(comma)$(SQLITE_PREFIX)/lib) $(if $(OPENSSL_PREFIX),-Wl$(comma)-rpath$(comma)$(OPENSSL_PREFIX)/lib) \
  -lsqlite3 -licui18n -licuuc -lcrypto -lpthread

all: build/parity_dump

build/parity_dump: ../tests/server/parity/dump.c
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -O2 -o $@ $< $(NATIVE_LIBS)

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

# Incident 18:42 (server/test/incident_1842.c): the page load must not open a collection Anki holds
# in exclusive mode (a -wal with no -shm), lock or no lock.
build/incident_1842: $(COL_SRC) test/incident_1842.c $(COL_HDR)
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) $(NATIVE_SAN) -o $@ $(COL_SRC) test/incident_1842.c $(NATIVE_LIBS)

# Anki's side of the same sequence as a program of its own, for the browser drive of it
# (ui/tools/incident1842.sh): a real server and a real page in the window instead of the calls.
build/anki_standin: test/anki_standin.c
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -O1 -o $@ test/anki_standin.c $(SQLITE_LDFLAGS) -lsqlite3

# The rule that nothing in amgi's C, nor in the cbase it links, calls pthread_cancel (server/test/c_rules.c).
# The tracked C comes from git; cbase/core and cbase/providers are walked by the program itself.
build/c_rules: test/c_rules.c test/srcscan.h
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -o $@ $<

# The incident-1842 rule: no checkpoint in any shipped C, JavaScript or Python (server/test/no_checkpoint.c).
# The tracked files come from git; the program decides which ship (srcscan.h, the scan's shared part).
build/no_checkpoint: test/no_checkpoint.c test/srcscan.h
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -o $@ $<

check-collection: build/unit build/backup_unit build/media_unit build/incident_1842 build/c_rules build/no_checkpoint
	build/unit $(CURDIR)/..
	build/backup_unit $(CURDIR)/..
	build/media_unit
	build/incident_1842 $(CURDIR)/..
	build/c_rules $(CURDIR)/.. $$(git -C .. ls-files -- '*.c' '*.h')
	build/no_checkpoint $(CURDIR)/.. $$(git -C .. ls-files)

# The collection CLI under ASan and UBSan, linked with cbase's sanitized build.
$(call prog,build/asan,build/obj/asan,build/obj/asan-extra,collection_cli,collection/cli.c,ASAN_CB_CFLAGS)

# The amgi app's own tests (server/test/app_unit.c), under ASan and UBSan.
$(call prog,build/asan,build/obj/asan,build/obj/asan-extra,app_unit,test/app_unit.c,ASAN_CB_CFLAGS)
check-app: build/asan/app_unit
	build/asan/app_unit

.PHONY: check-collection check-app

# The libraries build/amgi links, for test/license.test.mjs (every one of them has a notice).
print-ldlibs:
	@echo $(LDLIBS)
.PHONY: print-ldlibs
