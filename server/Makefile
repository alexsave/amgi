# amgi's native code: the collection core (server/collection, the C port of
# plusaudio/lib/collection and the direct transport), its CLI for the collection-parity runner, and
# the parity dump tool (test/parity/dump.c). The C server (L2) will sit beside these.
#
#   make -C server            build/collection_cli and build/parity_dump
#   make -C server check      the C unit tests, under ASan and UBSan
#
# sqlite is upstream's on every platform: on macOS Homebrew's (never Apple's /usr/lib/libsqlite3,
# which carries Apple's own changes), as cbase.mk resolves it. ICU is the one Node is built with
# (process.versions.icu, 78 today), so case folding, NFC and script lookups answer exactly as the
# Node code they replace did: on macOS Homebrew's icu4c@78.
CC ?= cc
ICU_MAJOR ?= 78
UNAME := $(shell uname -s)
ifeq ($(UNAME),Darwin)
  SQLITE_PREFIX ?= $(shell brew --prefix sqlite 2>/dev/null)
  ICU_PREFIX ?= $(shell brew --prefix icu4c@$(ICU_MAJOR) 2>/dev/null)
  OPENSSL_PREFIX ?= $(shell brew --prefix openssl@3 2>/dev/null)
  ifeq ($(wildcard $(SQLITE_PREFIX)/include/sqlite3.h),)
    $(error no Homebrew sqlite (SQLITE_PREFIX='$(SQLITE_PREFIX)'): brew install sqlite)
  endif
  ifeq ($(wildcard $(ICU_PREFIX)/include/unicode/uchar.h),)
    $(error no Homebrew ICU $(ICU_MAJOR) (ICU_PREFIX='$(ICU_PREFIX)'): brew install icu4c@$(ICU_MAJOR))
  endif
endif
DEP_CFLAGS := $(if $(SQLITE_PREFIX),-I$(SQLITE_PREFIX)/include) $(if $(ICU_PREFIX),-I$(ICU_PREFIX)/include) \
  $(if $(OPENSSL_PREFIX),-I$(OPENSSL_PREFIX)/include)
comma := ,
rpath = -L$(1)/lib -Wl$(comma)-rpath$(comma)$(1)/lib
DEP_LDFLAGS := $(if $(SQLITE_PREFIX),$(call rpath,$(SQLITE_PREFIX))) $(if $(ICU_PREFIX),$(call rpath,$(ICU_PREFIX))) \
  $(if $(OPENSSL_PREFIX),$(call rpath,$(OPENSSL_PREFIX)))
WARN := -Wall -Wextra -Werror -Wshadow -Wvla -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE
OPT ?= -O2 -g
SAN ?=
CFLAGS_ALL := $(WARN) $(OPT) $(SAN) $(DEP_CFLAGS) -pthread
LIBS := $(DEP_LDFLAGS) -lsqlite3 -licui18n -licuuc -lcrypto -lpthread
BUILD ?= build

COL_SRC := collection/util.c collection/rng.c collection/db.c collection/backup.c collection/text.c collection/pb.c \
  collection/decks.c collection/notes.c collection/media.c collection/direct.c json/anki_json.c
COL_HDR := $(wildcard collection/*.h json/*.h)

all: $(BUILD)/parity_dump $(BUILD)/collection_cli $(BUILD)/difftest

$(BUILD)/collection_cli: $(COL_SRC) collection/cli.c $(COL_HDR) | $(BUILD)
	$(CC) $(CFLAGS_ALL) -o $@ $(COL_SRC) collection/cli.c $(LIBS)

# The C side of test/parity/difftest.test.mjs, under the sanitizers.
$(BUILD)/difftest: $(COL_SRC) test/difftest.c $(COL_HDR) | $(BUILD)
	$(CC) $(WARN) -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all $(DEP_CFLAGS) -pthread \
	  -o $@ $(COL_SRC) test/difftest.c $(LIBS)

# The same CLI under AddressSanitizer and UndefinedBehaviorSanitizer, for the parity runner.
$(BUILD)/collection_cli_san: $(COL_SRC) collection/cli.c $(COL_HDR) | $(BUILD)
	$(CC) $(WARN) -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer $(DEP_CFLAGS) -pthread \
	  -o $@ $(COL_SRC) collection/cli.c $(LIBS)

$(BUILD)/parity_dump: ../test/parity/dump.c | $(BUILD)
	$(CC) $(CFLAGS_ALL) -o $@ $< $(LIBS)

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
