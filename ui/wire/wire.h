/* amgi's wire format: every /api/anki request body and answer between the app and its server as a
 * fixed binary layout. One table in wire.c, the schema, names each kind's fields in order with
 * their types and their JS key names; four walkers read it:
 *   - the app (ui/src) reads an answer into the C struct below (wire_decode) and writes a request
 *     from one (wire_encode);
 *   - the server (server/amgi) writes an answer from its C struct and reads a request into one, as
 *     the app does;
 *   - the tests and tools, through the same file built as ui/out/wire.wasm (wire_node.c and
 *     ui/wire/wire.mjs), write and read a message from a JS object, finding fields by the schema's
 *     key names.
 * So a field's order, width and name are written down once, in wire.c's table.
 *
 * The same format, and the same table, carry the Anki bridge add-on's protocol (the b_* kinds below):
 * the server's bridge client (server/collection/bridge.c) writes and reads them natively, and the add-on's Python (anki/addon/amgi_bridge/bridge_wire.py) through
 * anki/addon/amgi_bridge/wire_schema.py, which ui/wire/wire_py.c writes from this table at every
 * build. WIRE_BRIDGE_PROTOCOL names the protocol's version; both ends send it on every request and
 * answer (X-Amgi-Bridge-Protocol), and a mismatch is answered, not guessed at.
 *
 * The server answers every /api/anki request in it, as "application/x-amgi-wire", and takes a
 * request body only as that type (415 otherwise). There is no other format on this path.
 *
 * Bytes: little-endian. A string is a u32 byte count and that many bytes of UTF-8. A list is a u32
 * count and its items. A message is the u32 WIRE_MAGIC, a u8 kind, then the kind's fields. */
#ifndef AMGI_WIRE_H
#define AMGI_WIRE_H
#include <stddef.h>
#include <stdint.h>

#define WIRE_MAGIC 0x32574d41u /* "AMW2" */
#define WIRE_MIME "application/x-amgi-wire"
/* The bridge protocol's version. 1 is the first binary one; the add-on that spoke JSON sent none.
 * Change it with any change to a b_* kind or to a request kind the bridge reads. */
#define WIRE_BRIDGE_PROTOCOL 1u

/* Field types. */
enum {
  WT_BOOL,  /* u8: JS true is 1, anything else 0 */
  WT_TRI,   /* u8: true 1, false 0, anything else WIRE_UNKNOWN */
  WT_U32,   /* u32: a JS number, rounded, clamped to 0..2^32-1; missing 0 */
  WT_OPT,   /* u32: the same, but missing (or not a number) is WIRE_NONE and left out of a JS object */
  WT_I32,   /* i32: an index; missing WIRE_ABSENT and left out of a JS object */
  WT_I64,   /* i64: an Anki id (ms since 1970, past 2^32) */
  WT_STR,   /* string; missing "" */
  WT_MODE,  /* u8: a transport mode, by name (wire_mode_of) */
  WT_STRS,  /* list of strings */
  WT_LIST,  /* list of items of a sub-schema */
  WT_BYTES, /* bytes, laid out as a string is (a media file); missing none. Only the bridge uses it */
  WT_TYPES
};
#define WIRE_UNKNOWN 2u
#define WIRE_NONE 0xffffffffu
#define WIRE_ABSENT INT32_MIN

/* The transport modes (server/collection/transport.c). A name the table does not know (a newer
 * server) is WIRE_MODE_OTHER, which reads back as "". */
enum { WIRE_MODE_DIRECT, WIRE_MODE_BRIDGE, WIRE_MODE_LOCKED, WIRE_MODE_NOT_FOUND, WIRE_MODE_UNSUPPORTED_SCHEMA,
       WIRE_MODE_BRIDGE_NO_COLLECTION, WIRE_MODE_UNCONFIGURED, WIRE_MODE_BRIDGE_OUTDATED, WIRE_MODE_DAMAGED, WIRE_MODE_OTHER,
       WIRE_MODES };
const char *wire_mode_name(uint32_t mode);
uint32_t wire_mode_of(const char *s, uint32_t len);

typedef struct { const char *p; uint32_t len; } wire_str; /* points into the message's bytes */
typedef struct { wire_str *v; uint32_t n; } wire_strs;

/* ---- the kinds, and the C view of each ---- */
enum {
  /* answers */
  WK_ERROR, WK_STATUS, WK_DECKS, WK_INSTALL_STATE, WK_PROFILES, WK_NOTETYPES, WK_NOTES, WK_FIELD_VALUES,
  WK_DECK_CREATED, WK_DECK_RENAMED, WK_NOTE_ADDED, WK_NOTES_ADDED, WK_NOTE_CHANGED, WK_CARD_TEXT, WK_CLIP,
  WK_STARTER_STATE, WK_STARTER_BUILT, WK_INSTALLED, WK_DECK_SUMMARY, WK_DECK_REMOVED,
  /* requests */
  WK_Q_DECK_NAME, WK_Q_INSTALL, WK_Q_STARTER, WK_Q_NOTE, WK_Q_NOTES, WK_Q_NOTE_UPDATE, WK_Q_CARD_TEXT, WK_Q_AUDIO,
  /* the bridge add-on's answers (its requests are q_deck_name, q_note, q_notes, q_note_update and
   * b_q_media) */
  WK_B_ERROR, WK_B_STATUS, WK_B_DECKS, WK_B_NOTETYPES, WK_B_NOTES, WK_B_VALUES, WK_B_DECK_CREATED, WK_B_DECK,
  WK_B_NOTE, WK_B_NOTES_ADDED, WK_B_NOTE_REMOVED, WK_B_DECK_SUMMARY, WK_B_DECK_REMOVED, WK_B_MEDIA_EXISTS,
  WK_B_MEDIA_DATA, WK_B_MEDIA_ADDED,
  WK_B_Q_MEDIA,
  WK_KINDS
};
/* The kind's name as the server's route table spells it ("decks", "q_note"); 0 past the last. */
const char *wire_kind_name(uint32_t kind);

/* A 4xx or 5xx answer. retry_after_ms and max_wait_ms are WIRE_NONE unless Gemini's limit answered. */
typedef struct { uint32_t mode; wire_str error; uint32_t retry_after_ms; uint8_t not_started, daily_cap; uint32_t max_wait_ms; } wire_error;
typedef struct { uint32_t mode, schema_version; wire_str detail; } wire_status;
typedef struct { int64_t id; wire_str name; uint32_t note_count; } wire_deck;
typedef struct { uint32_t mode; wire_deck *decks; uint32_t ndecks; } wire_decks;
typedef struct { uint8_t installed, up_to_date, collection_checked; wire_strs stale; uint8_t ready; wire_str base_dir; } wire_install_state;
typedef struct { wire_str name, collection_path; } wire_profile;
typedef struct { wire_str base_dir; uint8_t base_dir_exists; wire_profile *profiles; uint32_t nprofiles; } wire_profiles;
typedef struct { int64_t id; wire_str name; wire_strs field_names; uint32_t sort_field_index; } wire_notetype;
typedef struct { uint32_t mode; wire_notetype *notetypes; uint32_t nnotetypes; } wire_notetypes;
typedef struct { int64_t id, notetype_id; wire_strs fields, tags; } wire_note;
typedef struct { uint32_t mode; wire_note *notes; uint32_t nnotes; uint32_t offset, limit; uint8_t has_more; } wire_notes;
typedef struct { uint32_t mode; wire_strs values; } wire_field_values;
typedef struct { uint32_t mode; int64_t id; wire_str name; uint8_t created; } wire_deck_created;
typedef struct { uint32_t mode; int64_t id; wire_str name; } wire_deck_renamed;
typedef struct { uint32_t mode; int64_t note_id; } wire_note_added;
typedef struct { uint8_t ok; int64_t note_id; wire_str error; } wire_note_result;
typedef struct { uint32_t mode; wire_note_result *results; uint32_t nresults; } wire_notes_added;
typedef struct { uint32_t mode; int64_t note_id; wire_str warning; } wire_note_changed;
typedef struct { wire_str filename, reference; } wire_clip_ref;
typedef struct { uint32_t mode; wire_str front_text, back_text; wire_clip_ref audio, cue_audio; } wire_card_text;
typedef struct { uint32_t mode; wire_str filename, reference; uint8_t reused; } wire_clip;
typedef struct { uint8_t offered, generation_available; wire_strs languages; uint32_t phrase_count; } wire_starter_state;
typedef struct { uint32_t mode; int64_t deck_id; wire_str deck_name; uint32_t added, already_there; } wire_starter_built;
typedef struct { uint8_t ok, needs_restart; wire_str message, addons_dir; } wire_installed;
/* What deleting a deck takes (GET /decks/:id): its subdecks, the cards that go, the notes left with
 * no card. What it took (DELETE /decks/:id): the decks removed, the cards, the notes. */
typedef struct { uint32_t mode; int64_t id; wire_str name; uint32_t subdecks, cards, notes; } wire_deck_summary;
typedef struct { uint32_t mode; int64_t id; wire_str name; uint32_t decks, cards, notes; } wire_deck_removed;

typedef struct { wire_str name; } wire_q_deck_name;
typedef struct { wire_str base_dir_override; } wire_q_install;
typedef struct { wire_str known, learning, name; } wire_q_starter;
typedef struct { int64_t deck_id, notetype_id; wire_strs fields, tags; wire_str language; int32_t learning_field_index; } wire_q_note;
typedef struct { wire_q_note *notes; uint32_t nnotes; } wire_q_notes;
typedef struct { wire_strs fields; wire_str language; int32_t learning_field_index; } wire_q_note_update;
typedef struct { wire_str user_input, known_language, learning_language; uint8_t include_cue_audio; } wire_q_card_text;
typedef struct { wire_str text, language; uint8_t fresh; } wire_q_audio;

/* The bridge add-on's messages: what bridge_ops.py answers, field for field. schema_version is
 * WIRE_NONE with no collection open. */
typedef struct { uint8_t profile_open; wire_str profile_name; uint8_t collection_open; uint32_t schema_version;
                 wire_str anki_version, qt_version; } wire_b_status;
typedef struct { wire_str error; } wire_b_error;
typedef struct { int64_t id; wire_str name; } wire_b_deck; /* a deck listed, or renamed */
typedef struct { wire_b_deck *decks; uint32_t ndecks; } wire_b_decks;
typedef struct { uint32_t ord; wire_str name, question_format, answer_format; } wire_b_template;
typedef struct { int64_t id; wire_str name, kind; uint32_t sort_field_index; wire_strs field_names;
                 wire_b_template *templates; uint32_t ntemplates; } wire_b_notetype;
typedef struct { wire_b_notetype *notetypes; uint32_t nnotetypes; } wire_b_notetypes;
typedef struct { wire_note *notes; uint32_t nnotes; uint32_t total, offset, limit; } wire_b_notes;
typedef struct { wire_strs values; } wire_b_values;
typedef struct { int64_t id; wire_str name; uint8_t created; } wire_b_deck_created;
typedef struct { int64_t note_id; wire_str warning; } wire_b_note; /* a note added or changed */
typedef struct { wire_note_result *results; uint32_t nresults; } wire_b_notes_added;
typedef struct { int64_t note_id; uint32_t cards_removed; } wire_b_note_removed;
typedef struct { int64_t id; wire_str name; uint32_t subdecks, cards, notes; } wire_b_deck_summary;
typedef struct { int64_t id; wire_str name; uint32_t decks, cards, notes; } wire_b_deck_removed;
typedef struct { uint8_t exists; } wire_b_media_exists;
typedef struct { uint8_t found; wire_str data; } wire_b_media_data;
typedef struct { wire_str filename; } wire_b_media_added;
typedef struct { wire_str filename, data; } wire_b_q_media;

/* ---- the schema (wire.c's table), for the walkers ---- */
typedef struct wire_schema wire_schema;
typedef struct {
  const char *key;          /* the JS name; dotted for a nested object ("audio.reference") */
  uint8_t type;             /* WT_* */
  uint16_t off;             /* where the field sits in the C struct (a list: its items pointer) */
  uint16_t off_n;           /* a WT_LIST: where its count sits */
  const wire_schema *sub;   /* a WT_LIST: its items */
} wire_field;
struct wire_schema { const wire_field *f; uint32_t n; uint32_t size; };
const wire_schema *wire_schema_of(uint32_t kind);

/* ---- the app's side ---- */
/* The kind of the message at p, or -1 when it does not start with the magic. */
int32_t wire_kind(const uint8_t *p, uint32_t len);
/* The room wire_decode needs for its lists, or WIRE_NONE when the bytes are not one whole message
 * of that kind (nothing short, nothing left over). */
uint32_t wire_room(uint32_t kind, const uint8_t *p, uint32_t len);
/* Reads the message into out (the kind's struct), once wire_room has said it is whole (wire_room is
 * the one check of the bytes): strings point into p, lists are laid out in mem (wire_room bytes of
 * it, 8-aligned). */
void wire_decode(uint32_t kind, const uint8_t *p, uint32_t len, void *out, void *mem);

/* A message being written, into a buffer of the writer's own that wire_grow resizes. */
typedef struct { uint8_t *p; uint32_t len, cap; } wire_buf;
void wire_begin(wire_buf *b, uint32_t kind);  /* from the buffer's start: the magic and the kind */
void wire_encode(wire_buf *b, uint32_t kind, const void *in); /* wire_begin, then in's fields */
uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap);   /* the build supplies it */
/* The primitive writes, for the server's walker (wire_node.c). */
void wire_u8(wire_buf *b, uint32_t v);
void wire_u32(wire_buf *b, uint32_t v);
void wire_i64(wire_buf *b, int64_t v);
void wire_bytes(wire_buf *b, const void *p, uint32_t n); /* a string: its count, then the bytes */
/* The primitive reads, for the server's walker. A read past the end sets in->bad and answers 0. */
typedef struct { const uint8_t *p, *end; int bad; } wire_in;
uint32_t wire_r_u8(wire_in *in);
uint32_t wire_r_u32(wire_in *in);
int64_t wire_r_i64(wire_in *in);
wire_str wire_r_str(wire_in *in);
int wire_open(wire_in *in, uint32_t kind, const uint8_t *p, uint32_t len); /* past the magic and kind */
#endif
