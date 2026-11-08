/* amgi's wire format: the /api/anki answers as fixed binary layouts, written and read by this one
 * C file. The browser app links the readers; the Node server loads the same file built as
 * ui/out/wire.wasm and calls the writers through ui/server/wire.mjs, which only copies arguments in.
 * So the layout has one owner: a field's order and width are written down here and nowhere else.
 *
 * Every number is little-endian. A string is a u32 byte count then that many bytes of UTF-8.
 * An answer starts with the u32 WIRE_MAGIC, then a u8 kind, then the kind's body:
 *   WIRE_ERROR    u8 mode, u32 retry_after_ms (WIRE_NO_RETRY: none), u8 flags (WIRE_F_*), str error
 *   WIRE_STATUS   u8 mode, u32 schema_version, str detail
 *   WIRE_DECKS    u8 mode, u32 n, then n times: i64 id, u32 note_count, str name
 *   WIRE_INSTALL  u8 installed, u8 up_to_date (WIRE_UNKNOWN: null), u8 collection_checked,
 *                 u32 stale_count, u8 ready
 *   WIRE_PROFILES str base_dir, u8 base_dir_exists, u32 n, then n times: str name, str collection_path
 * A client asks for it with the request header "Accept: application/x-amgi-wire"; without it the
 * server answers the JSON that skills/amgi documents, unchanged. */
#ifndef AMGI_WIRE_H
#define AMGI_WIRE_H
#include <stdint.h>

#define WIRE_MAGIC 0x31574d41u /* "AMW1" */
#define WIRE_MIME "application/x-amgi-wire"

enum { WIRE_ERROR, WIRE_STATUS, WIRE_DECKS, WIRE_INSTALL, WIRE_PROFILES, WIRE_KINDS };

/* The transport modes of src/server/anki/transport.js, in the order this table names them.
 * A mode the table does not know (a newer server) is WIRE_MODE_OTHER. */
enum { WIRE_MODE_DIRECT, WIRE_MODE_BRIDGE, WIRE_MODE_LOCKED, WIRE_MODE_NOT_FOUND, WIRE_MODE_UNSUPPORTED_SCHEMA,
       WIRE_MODE_BRIDGE_NO_COLLECTION, WIRE_MODE_UNCONFIGURED, WIRE_MODE_OTHER, WIRE_MODES };
/* The mode's name as the JSON API spells it ("not-found"), for mode < WIRE_MODES ("" for OTHER). */
const char *wire_mode_name(uint32_t mode);
uint32_t wire_mode_of(const char *s, uint32_t len);

#define WIRE_NO_RETRY 0xffffffffu
#define WIRE_UNKNOWN 2u
enum { WIRE_F_NOT_STARTED = 1, WIRE_F_DAILY_CAP = 2 };

/* ---- reading: the app's side. A string read is a pointer into the answer's bytes (valid while
 * they are) and a length. Every reader checks bounds and returns 0 for bytes that are not a whole
 * answer of that kind, 1 for one that is. ---- */
typedef struct { const uint8_t *p, *end; int bad; uint32_t left; } wire_in; /* left: items still to read */
typedef struct { const char *p; uint32_t len; } wire_str;

/* The kind of the answer in p, len, or -1 when it does not start with the magic. */
int32_t wire_kind(const uint8_t *p, uint32_t len);
/* An answer of kind WIRE_ERROR. */
typedef struct { uint32_t mode, retry_after_ms, flags; wire_str error; } wire_error;
int wire_read_error(const uint8_t *p, uint32_t len, wire_error *out);
typedef struct { uint32_t mode, schema_version; wire_str detail; } wire_status;
int wire_read_status(const uint8_t *p, uint32_t len, wire_status *out);
/* The decks answer is read deck by deck: wire_decks_open reads its head, then each wire_decks_next
 * one deck (n of them; a call past the last, or on bad bytes, returns 0). */
typedef struct { int64_t id; uint32_t note_count; wire_str name; } wire_deck;
int wire_decks_open(wire_in *in, const uint8_t *p, uint32_t len, uint32_t *mode, uint32_t *n);
int wire_decks_next(wire_in *in, wire_deck *out);
/* wire_decks_open, then every deck, checked to the end: 1 when the whole answer is well formed. */
int wire_decks_check(const uint8_t *p, uint32_t len);
typedef struct { uint32_t installed, up_to_date, collection_checked, stale_count, ready; } wire_install;
int wire_read_install(const uint8_t *p, uint32_t len, wire_install *out);
typedef struct { wire_str name, collection_path; } wire_profile;
int wire_profiles_open(wire_in *in, const uint8_t *p, uint32_t len, wire_str *base_dir, uint32_t *exists, uint32_t *n);
int wire_profiles_next(wire_in *in, wire_profile *out);

/* ---- writing: the server's side. One answer at a time, into a buffer of the writer's own:
 * wire_begin starts one (forgetting the last), each call below appends, wire_out names the bytes.
 * Strings are passed as (pointer, length) of UTF-8. ---- */
typedef struct { uint8_t *p; uint32_t len, cap; } wire_buf;
void wire_begin(wire_buf *b, uint32_t kind);
void wire_w_error(wire_buf *b, const char *mode, uint32_t mlen, uint32_t retry_after_ms, uint32_t flags,
                  const char *err, uint32_t elen);
void wire_w_status(wire_buf *b, const char *mode, uint32_t mlen, uint32_t schema_version, const char *detail,
                   uint32_t dlen);
void wire_w_decks_head(wire_buf *b, const char *mode, uint32_t mlen, uint32_t n);
void wire_w_deck(wire_buf *b, int64_t id, uint32_t note_count, const char *name, uint32_t nlen);
void wire_w_install(wire_buf *b, uint32_t installed, uint32_t up_to_date, uint32_t collection_checked,
                    uint32_t stale_count, uint32_t ready);
void wire_w_profiles_head(wire_buf *b, const char *base_dir, uint32_t blen, uint32_t exists, uint32_t n);
void wire_w_profile(wire_buf *b, const char *name, uint32_t nlen, const char *path, uint32_t plen);
/* The writer's growth: the caller supplies it (the app's and the server's builds differ). Returns
 * a buffer of at least cap bytes holding the first len bytes of p. */
uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap);
#endif
