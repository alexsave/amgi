/* amgi's wire format: the schema, and the app's two walkers over it (see wire.h). */
#include "wire.h"

static const char *const MODE_NAMES[WIRE_MODES] = {
  "direct", "bridge", "locked", "not-found", "unsupported-schema", "bridge-no-collection", "unconfigured",
  "bridge-outdated", "",
};

const char *wire_mode_name(uint32_t mode) { return mode < WIRE_MODES ? MODE_NAMES[mode] : ""; }

uint32_t wire_mode_of(const char *s, uint32_t len) {
  for (uint32_t m = 0; m < WIRE_MODE_OTHER; m++) {
    const char *n = MODE_NAMES[m];
    uint32_t k = 0;
    while (k < len && n[k] && n[k] == s[k]) k++;
    if (k == len && !n[k]) return m;
  }
  return WIRE_MODE_OTHER;
}

/* ---- the schema: every kind's fields, in wire order ---- */
#define F(T, key, type, m) {key, type, (uint16_t)offsetof(T, m), 0, 0}
#define LIST(T, key, m, n, sub) {key, WT_LIST, (uint16_t)offsetof(T, m), (uint16_t)offsetof(T, n), &sub}
#define SCHEMA(name, T, ...)                                                          \
  static const wire_field name##_f[] = {__VA_ARGS__};                                 \
  static const wire_schema name = {name##_f, sizeof name##_f / sizeof *name##_f, sizeof(T)}

SCHEMA(s_error, wire_error,
  F(wire_error, "mode", WT_MODE, mode), F(wire_error, "error", WT_STR, error),
  F(wire_error, "retryAfterMs", WT_OPT, retry_after_ms), F(wire_error, "notStarted", WT_BOOL, not_started),
  F(wire_error, "dailyCap", WT_BOOL, daily_cap), F(wire_error, "maxWaitMs", WT_OPT, max_wait_ms));
SCHEMA(s_status, wire_status,
  F(wire_status, "mode", WT_MODE, mode), F(wire_status, "schemaVersion", WT_U32, schema_version),
  F(wire_status, "detail", WT_STR, detail));
SCHEMA(s_deck, wire_deck,
  F(wire_deck, "id", WT_I64, id), F(wire_deck, "name", WT_STR, name), F(wire_deck, "noteCount", WT_U32, note_count));
SCHEMA(s_decks, wire_decks, F(wire_decks, "mode", WT_MODE, mode), LIST(wire_decks, "decks", decks, ndecks, s_deck));
SCHEMA(s_install_state, wire_install_state,
  F(wire_install_state, "installed", WT_BOOL, installed), F(wire_install_state, "upToDate", WT_TRI, up_to_date),
  F(wire_install_state, "collectionChecked", WT_BOOL, collection_checked),
  F(wire_install_state, "collectionStale", WT_STRS, stale), F(wire_install_state, "ready", WT_BOOL, ready),
  F(wire_install_state, "baseDir", WT_STR, base_dir));
SCHEMA(s_profile, wire_profile,
  F(wire_profile, "name", WT_STR, name), F(wire_profile, "collectionPath", WT_STR, collection_path));
SCHEMA(s_profiles, wire_profiles,
  F(wire_profiles, "baseDir", WT_STR, base_dir), F(wire_profiles, "baseDirExists", WT_BOOL, base_dir_exists),
  LIST(wire_profiles, "profiles", profiles, nprofiles, s_profile));
SCHEMA(s_notetype, wire_notetype,
  F(wire_notetype, "id", WT_I64, id), F(wire_notetype, "name", WT_STR, name),
  F(wire_notetype, "fieldNames", WT_STRS, field_names), F(wire_notetype, "sortFieldIndex", WT_U32, sort_field_index));
SCHEMA(s_notetypes, wire_notetypes,
  F(wire_notetypes, "mode", WT_MODE, mode), LIST(wire_notetypes, "notetypes", notetypes, nnotetypes, s_notetype));
SCHEMA(s_note, wire_note,
  F(wire_note, "id", WT_I64, id), F(wire_note, "notetypeId", WT_I64, notetype_id),
  F(wire_note, "fields", WT_STRS, fields), F(wire_note, "tags", WT_STRS, tags));
SCHEMA(s_notes, wire_notes,
  F(wire_notes, "mode", WT_MODE, mode), LIST(wire_notes, "notes", notes, nnotes, s_note),
  F(wire_notes, "offset", WT_U32, offset), F(wire_notes, "limit", WT_U32, limit), F(wire_notes, "hasMore", WT_BOOL, has_more));
SCHEMA(s_field_values, wire_field_values,
  F(wire_field_values, "mode", WT_MODE, mode), F(wire_field_values, "values", WT_STRS, values));
SCHEMA(s_deck_created, wire_deck_created,
  F(wire_deck_created, "mode", WT_MODE, mode), F(wire_deck_created, "deck.id", WT_I64, id),
  F(wire_deck_created, "deck.name", WT_STR, name), F(wire_deck_created, "created", WT_BOOL, created));
SCHEMA(s_deck_renamed, wire_deck_renamed,
  F(wire_deck_renamed, "mode", WT_MODE, mode), F(wire_deck_renamed, "id", WT_I64, id),
  F(wire_deck_renamed, "name", WT_STR, name));
SCHEMA(s_note_added, wire_note_added,
  F(wire_note_added, "mode", WT_MODE, mode), F(wire_note_added, "noteId", WT_I64, note_id));
SCHEMA(s_note_result, wire_note_result,
  F(wire_note_result, "ok", WT_BOOL, ok), F(wire_note_result, "noteId", WT_I64, note_id),
  F(wire_note_result, "error", WT_STR, error));
SCHEMA(s_notes_added, wire_notes_added,
  F(wire_notes_added, "mode", WT_MODE, mode), LIST(wire_notes_added, "results", results, nresults, s_note_result));
SCHEMA(s_note_changed, wire_note_changed,
  F(wire_note_changed, "mode", WT_MODE, mode), F(wire_note_changed, "noteId", WT_I64, note_id),
  F(wire_note_changed, "warning", WT_STR, warning));
SCHEMA(s_card_text, wire_card_text,
  F(wire_card_text, "mode", WT_MODE, mode), F(wire_card_text, "front_text", WT_STR, front_text),
  F(wire_card_text, "back_text", WT_STR, back_text), F(wire_card_text, "audio.filename", WT_STR, audio.filename),
  F(wire_card_text, "audio.reference", WT_STR, audio.reference),
  F(wire_card_text, "cueAudio.filename", WT_STR, cue_audio.filename),
  F(wire_card_text, "cueAudio.reference", WT_STR, cue_audio.reference));
SCHEMA(s_clip, wire_clip,
  F(wire_clip, "mode", WT_MODE, mode), F(wire_clip, "filename", WT_STR, filename),
  F(wire_clip, "reference", WT_STR, reference), F(wire_clip, "reused", WT_BOOL, reused));
SCHEMA(s_starter_state, wire_starter_state,
  F(wire_starter_state, "offered", WT_BOOL, offered),
  F(wire_starter_state, "generationAvailable", WT_BOOL, generation_available),
  F(wire_starter_state, "languages", WT_STRS, languages), F(wire_starter_state, "phraseCount", WT_U32, phrase_count));
SCHEMA(s_starter_built, wire_starter_built,
  F(wire_starter_built, "mode", WT_MODE, mode), F(wire_starter_built, "deckId", WT_I64, deck_id),
  F(wire_starter_built, "deckName", WT_STR, deck_name), F(wire_starter_built, "added", WT_U32, added),
  F(wire_starter_built, "alreadyThere", WT_U32, already_there));
SCHEMA(s_installed, wire_installed,
  F(wire_installed, "ok", WT_BOOL, ok), F(wire_installed, "needsRestart", WT_BOOL, needs_restart),
  F(wire_installed, "message", WT_STR, message), F(wire_installed, "addonsDir", WT_STR, addons_dir));
SCHEMA(s_deck_summary, wire_deck_summary,
  F(wire_deck_summary, "mode", WT_MODE, mode), F(wire_deck_summary, "id", WT_I64, id),
  F(wire_deck_summary, "name", WT_STR, name), F(wire_deck_summary, "subdecks", WT_U32, subdecks),
  F(wire_deck_summary, "cards", WT_U32, cards), F(wire_deck_summary, "notes", WT_U32, notes));
SCHEMA(s_deck_removed, wire_deck_removed,
  F(wire_deck_removed, "mode", WT_MODE, mode), F(wire_deck_removed, "id", WT_I64, id),
  F(wire_deck_removed, "name", WT_STR, name), F(wire_deck_removed, "decks", WT_U32, decks),
  F(wire_deck_removed, "cards", WT_U32, cards), F(wire_deck_removed, "notes", WT_U32, notes));

SCHEMA(s_q_deck_name, wire_q_deck_name, F(wire_q_deck_name, "name", WT_STR, name));
SCHEMA(s_q_install, wire_q_install, F(wire_q_install, "baseDirOverride", WT_STR, base_dir_override));
SCHEMA(s_q_starter, wire_q_starter,
  F(wire_q_starter, "known", WT_STR, known), F(wire_q_starter, "learning", WT_STR, learning),
  F(wire_q_starter, "name", WT_STR, name));
SCHEMA(s_q_note, wire_q_note,
  F(wire_q_note, "deckId", WT_I64, deck_id), F(wire_q_note, "notetypeId", WT_I64, notetype_id),
  F(wire_q_note, "fields", WT_STRS, fields), F(wire_q_note, "tags", WT_STRS, tags),
  F(wire_q_note, "language", WT_STR, language), F(wire_q_note, "learningFieldIndex", WT_I32, learning_field_index));
SCHEMA(s_q_notes, wire_q_notes, LIST(wire_q_notes, "notes", notes, nnotes, s_q_note));
SCHEMA(s_q_note_update, wire_q_note_update,
  F(wire_q_note_update, "fields", WT_STRS, fields), F(wire_q_note_update, "language", WT_STR, language),
  F(wire_q_note_update, "learningFieldIndex", WT_I32, learning_field_index));
SCHEMA(s_q_card_text, wire_q_card_text,
  F(wire_q_card_text, "userInput", WT_STR, user_input), F(wire_q_card_text, "knownLanguage", WT_STR, known_language),
  F(wire_q_card_text, "learningLanguage", WT_STR, learning_language),
  F(wire_q_card_text, "includeCueAudio", WT_BOOL, include_cue_audio));
SCHEMA(s_q_audio, wire_q_audio,
  F(wire_q_audio, "text", WT_STR, text), F(wire_q_audio, "language", WT_STR, language),
  F(wire_q_audio, "fresh", WT_BOOL, fresh));

SCHEMA(s_b_error, wire_b_error, F(wire_b_error, "error", WT_STR, error));
SCHEMA(s_b_status, wire_b_status,
  F(wire_b_status, "profileOpen", WT_BOOL, profile_open), F(wire_b_status, "profileName", WT_STR, profile_name),
  F(wire_b_status, "collectionOpen", WT_BOOL, collection_open),
  F(wire_b_status, "schemaVersion", WT_OPT, schema_version), F(wire_b_status, "ankiVersion", WT_STR, anki_version),
  F(wire_b_status, "qtVersion", WT_STR, qt_version));
SCHEMA(s_b_deck, wire_b_deck, F(wire_b_deck, "id", WT_I64, id), F(wire_b_deck, "name", WT_STR, name));
SCHEMA(s_b_decks, wire_b_decks, LIST(wire_b_decks, "decks", decks, ndecks, s_b_deck));
SCHEMA(s_b_template, wire_b_template,
  F(wire_b_template, "ord", WT_U32, ord), F(wire_b_template, "name", WT_STR, name),
  F(wire_b_template, "questionFormat", WT_STR, question_format),
  F(wire_b_template, "answerFormat", WT_STR, answer_format));
SCHEMA(s_b_notetype, wire_b_notetype,
  F(wire_b_notetype, "id", WT_I64, id), F(wire_b_notetype, "name", WT_STR, name),
  F(wire_b_notetype, "kind", WT_STR, kind), F(wire_b_notetype, "sortFieldIndex", WT_U32, sort_field_index),
  F(wire_b_notetype, "fieldNames", WT_STRS, field_names),
  LIST(wire_b_notetype, "templates", templates, ntemplates, s_b_template));
SCHEMA(s_b_notetypes, wire_b_notetypes, LIST(wire_b_notetypes, "notetypes", notetypes, nnotetypes, s_b_notetype));
SCHEMA(s_b_notes, wire_b_notes,
  LIST(wire_b_notes, "notes", notes, nnotes, s_note), F(wire_b_notes, "total", WT_U32, total),
  F(wire_b_notes, "offset", WT_U32, offset), F(wire_b_notes, "limit", WT_U32, limit));
SCHEMA(s_b_values, wire_b_values, F(wire_b_values, "values", WT_STRS, values));
SCHEMA(s_b_deck_created, wire_b_deck_created,
  F(wire_b_deck_created, "deck.id", WT_I64, id), F(wire_b_deck_created, "deck.name", WT_STR, name),
  F(wire_b_deck_created, "created", WT_BOOL, created));
SCHEMA(s_b_note, wire_b_note, F(wire_b_note, "noteId", WT_I64, note_id), F(wire_b_note, "warning", WT_STR, warning));
SCHEMA(s_b_notes_added, wire_b_notes_added, LIST(wire_b_notes_added, "results", results, nresults, s_note_result));
SCHEMA(s_b_note_removed, wire_b_note_removed,
  F(wire_b_note_removed, "noteId", WT_I64, note_id), F(wire_b_note_removed, "cardsRemoved", WT_U32, cards_removed));
SCHEMA(s_b_deck_summary, wire_b_deck_summary,
  F(wire_b_deck_summary, "id", WT_I64, id), F(wire_b_deck_summary, "name", WT_STR, name),
  F(wire_b_deck_summary, "subdecks", WT_U32, subdecks), F(wire_b_deck_summary, "cards", WT_U32, cards),
  F(wire_b_deck_summary, "notes", WT_U32, notes));
SCHEMA(s_b_deck_removed, wire_b_deck_removed,
  F(wire_b_deck_removed, "id", WT_I64, id), F(wire_b_deck_removed, "name", WT_STR, name),
  F(wire_b_deck_removed, "decks", WT_U32, decks), F(wire_b_deck_removed, "cards", WT_U32, cards),
  F(wire_b_deck_removed, "notes", WT_U32, notes));
SCHEMA(s_b_media_exists, wire_b_media_exists, F(wire_b_media_exists, "exists", WT_BOOL, exists));
SCHEMA(s_b_media_data, wire_b_media_data,
  F(wire_b_media_data, "found", WT_BOOL, found), F(wire_b_media_data, "data", WT_BYTES, data));
SCHEMA(s_b_media_added, wire_b_media_added, F(wire_b_media_added, "filename", WT_STR, filename));
SCHEMA(s_b_q_media, wire_b_q_media,
  F(wire_b_q_media, "filename", WT_STR, filename), F(wire_b_q_media, "data", WT_BYTES, data));

static const struct { const char *name; const wire_schema *schema; } KINDS[WK_KINDS] = {
  [WK_ERROR] = {"error", &s_error}, [WK_STATUS] = {"status", &s_status}, [WK_DECKS] = {"decks", &s_decks},
  [WK_INSTALL_STATE] = {"install_state", &s_install_state}, [WK_PROFILES] = {"profiles", &s_profiles},
  [WK_NOTETYPES] = {"notetypes", &s_notetypes}, [WK_NOTES] = {"notes", &s_notes},
  [WK_FIELD_VALUES] = {"field_values", &s_field_values}, [WK_DECK_CREATED] = {"deck_created", &s_deck_created},
  [WK_DECK_RENAMED] = {"deck_renamed", &s_deck_renamed}, [WK_NOTE_ADDED] = {"note_added", &s_note_added},
  [WK_NOTES_ADDED] = {"notes_added", &s_notes_added}, [WK_NOTE_CHANGED] = {"note_changed", &s_note_changed},
  [WK_CARD_TEXT] = {"card_text", &s_card_text}, [WK_CLIP] = {"clip", &s_clip},
  [WK_STARTER_STATE] = {"starter_state", &s_starter_state}, [WK_STARTER_BUILT] = {"starter_built", &s_starter_built},
  [WK_INSTALLED] = {"installed", &s_installed}, [WK_DECK_SUMMARY] = {"deck_summary", &s_deck_summary},
  [WK_DECK_REMOVED] = {"deck_removed", &s_deck_removed},
  [WK_Q_DECK_NAME] = {"q_deck_name", &s_q_deck_name}, [WK_Q_INSTALL] = {"q_install", &s_q_install},
  [WK_Q_STARTER] = {"q_starter", &s_q_starter}, [WK_Q_NOTE] = {"q_note", &s_q_note},
  [WK_Q_NOTES] = {"q_notes", &s_q_notes}, [WK_Q_NOTE_UPDATE] = {"q_note_update", &s_q_note_update},
  [WK_Q_CARD_TEXT] = {"q_card_text", &s_q_card_text}, [WK_Q_AUDIO] = {"q_audio", &s_q_audio},
  [WK_B_ERROR] = {"b_error", &s_b_error}, [WK_B_STATUS] = {"b_status", &s_b_status},
  [WK_B_DECKS] = {"b_decks", &s_b_decks}, [WK_B_NOTETYPES] = {"b_notetypes", &s_b_notetypes},
  [WK_B_NOTES] = {"b_notes", &s_b_notes}, [WK_B_VALUES] = {"b_values", &s_b_values},
  [WK_B_DECK_CREATED] = {"b_deck_created", &s_b_deck_created}, [WK_B_DECK] = {"b_deck", &s_b_deck},
  [WK_B_NOTE] = {"b_note", &s_b_note}, [WK_B_NOTES_ADDED] = {"b_notes_added", &s_b_notes_added},
  [WK_B_NOTE_REMOVED] = {"b_note_removed", &s_b_note_removed},
  [WK_B_DECK_SUMMARY] = {"b_deck_summary", &s_b_deck_summary},
  [WK_B_DECK_REMOVED] = {"b_deck_removed", &s_b_deck_removed},
  [WK_B_MEDIA_EXISTS] = {"b_media_exists", &s_b_media_exists},
  [WK_B_MEDIA_DATA] = {"b_media_data", &s_b_media_data}, [WK_B_MEDIA_ADDED] = {"b_media_added", &s_b_media_added},
  [WK_B_Q_MEDIA] = {"b_q_media", &s_b_q_media},
};
const char *wire_kind_name(uint32_t kind) { return kind < WK_KINDS ? KINDS[kind].name : 0; }
const wire_schema *wire_schema_of(uint32_t kind) { return kind < WK_KINDS ? KINDS[kind].schema : 0; }

/* ---- primitive reads ---- */
uint32_t wire_r_u8(wire_in *in) {
  if (in->bad || in->end - in->p < 1) return in->bad = 1, 0;
  return *in->p++;
}
uint32_t wire_r_u32(wire_in *in) {
  if (in->bad || in->end - in->p < 4) return in->bad = 1, 0;
  const uint8_t *p = in->p;
  in->p += 4;
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
int64_t wire_r_i64(wire_in *in) {
  uint64_t lo = wire_r_u32(in), hi = wire_r_u32(in);
  return (int64_t)(lo | hi << 32);
}
wire_str wire_r_str(wire_in *in) {
  wire_str s = {"", 0};
  uint32_t n = wire_r_u32(in);
  if (in->bad || (uint32_t)(in->end - in->p) < n) return in->bad = 1, s;
  s.p = (const char *)in->p;
  s.len = n;
  in->p += n;
  return s;
}
int wire_open(wire_in *in, uint32_t kind, const uint8_t *p, uint32_t len) {
  in->p = p;
  in->end = p + len;
  in->bad = 0;
  if (wire_r_u32(in) != WIRE_MAGIC) return 0;
  return wire_r_u8(in) == kind && !in->bad;
}
int32_t wire_kind(const uint8_t *p, uint32_t len) {
  wire_in in = {p, p + len, 0};
  if (wire_r_u32(&in) != WIRE_MAGIC) return -1;
  uint32_t k = wire_r_u8(&in);
  return in.bad ? -1 : (int32_t)k;
}

/* ---- the app's reader: one walk that either counts the room its lists need (out 0) or fills ---- */
#define ALIGN8(n) (((n) + 7u) & ~7u)
typedef struct { uint8_t *mem; uint32_t used; } room;

static void walk_read(wire_in *in, const wire_schema *s, uint8_t *out, room *r);
static void *take(room *r, uint32_t n) {
  void *at = r->mem ? r->mem + r->used : 0;
  r->used += ALIGN8(n);
  return at;
}
static void walk_field(wire_in *in, const wire_field *f, uint8_t *out, room *r) {
  uint8_t *at = out ? out + f->off : 0;
  switch (f->type) {
  case WT_BOOL: case WT_TRI: case WT_MODE: {
    uint32_t v = wire_r_u8(in);
    if (!at) break;
    if (f->type == WT_MODE) *(uint32_t *)at = v;
    else *at = (uint8_t)v;
    break;
  }
  case WT_U32: case WT_OPT: case WT_I32: {
    uint32_t v = wire_r_u32(in);
    if (at) *(uint32_t *)at = v;
    break;
  }
  case WT_I64: {
    int64_t v = wire_r_i64(in);
    if (at) __builtin_memcpy(at, &v, sizeof v);
    break;
  }
  case WT_STR: case WT_BYTES: {
    wire_str v = wire_r_str(in);
    if (at) *(wire_str *)at = v;
    break;
  }
  case WT_STRS: {
    /* A count past what the bytes hold costs nothing: the first read past the end sets bad and every
     * loop here stops on it, and room is only ever taken for a message wire_room found whole. */
    uint32_t n = wire_r_u32(in);
    wire_str *v = take(r, n * (uint32_t)sizeof(wire_str));
    for (uint32_t i = 0; i < n && !in->bad; i++) {
      wire_str s = wire_r_str(in);
      if (v) v[i] = s;
    }
    if (at) *(wire_strs *)at = (wire_strs){v, n};
    break;
  }
  case WT_LIST: {
    uint32_t n = wire_r_u32(in);
    uint8_t *items = take(r, n * f->sub->size);
    for (uint32_t i = 0; i < n && !in->bad; i++) walk_read(in, f->sub, items ? items + i * f->sub->size : 0, r);
    if (at) {
      *(void **)at = items;
      *(uint32_t *)(out + f->off_n) = n;
    }
    break;
  }
  default: in->bad = 1;
  }
}
static void walk_read(wire_in *in, const wire_schema *s, uint8_t *out, room *r) {
  if (out) __builtin_memset(out, 0, s->size);
  for (uint32_t i = 0; i < s->n && !in->bad; i++) walk_field(in, &s->f[i], out, r);
}

uint32_t wire_room(uint32_t kind, const uint8_t *p, uint32_t len) {
  wire_in in;
  room r = {0, 0};
  if (kind >= WK_KINDS || !wire_open(&in, kind, p, len)) return WIRE_NONE;
  walk_read(&in, KINDS[kind].schema, 0, &r);
  return in.bad || in.p != in.end ? WIRE_NONE : r.used;
}
/* Only after wire_room said the bytes are whole: that is the one check of them. */
void wire_decode(uint32_t kind, const uint8_t *p, uint32_t len, void *out, void *mem) {
  wire_in in;
  room r = {mem, 0};
  wire_open(&in, kind, p, len);
  walk_read(&in, KINDS[kind].schema, out, &r);
}

/* ---- primitive writes ---- */
static uint8_t *w_room(wire_buf *b, uint32_t n) {
  if (b->cap - b->len < n) {
    uint32_t cap = b->cap ? b->cap : 256;
    while (cap - b->len < n) cap *= 2;
    b->p = wire_grow(b->p, b->len, cap);
    b->cap = cap;
  }
  uint8_t *at = b->p + b->len;
  b->len += n;
  return at;
}
void wire_u8(wire_buf *b, uint32_t v) { *w_room(b, 1) = (uint8_t)v; }
void wire_u32(wire_buf *b, uint32_t v) {
  uint8_t *p = w_room(b, 4);
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}
void wire_i64(wire_buf *b, int64_t v) {
  wire_u32(b, (uint32_t)(uint64_t)v);
  wire_u32(b, (uint32_t)((uint64_t)v >> 32));
}
void wire_bytes(wire_buf *b, const void *p, uint32_t n) {
  wire_u32(b, n);
  if (n) __builtin_memcpy(w_room(b, n), p, n);
}
void wire_begin(wire_buf *b, uint32_t kind) {
  b->len = 0;
  wire_u32(b, WIRE_MAGIC);
  wire_u8(b, kind);
}

/* ---- the app's writer: a request from its struct ---- */
static void walk_write(wire_buf *b, const wire_schema *s, const uint8_t *in) {
  for (uint32_t i = 0; i < s->n; i++) {
    const wire_field *f = &s->f[i];
    const uint8_t *at = in + f->off;
    switch (f->type) {
    case WT_BOOL: case WT_TRI: wire_u8(b, *at); break;
    case WT_MODE: wire_u8(b, *(const uint32_t *)at); break;
    case WT_U32: case WT_OPT: case WT_I32: wire_u32(b, *(const uint32_t *)at); break;
    case WT_I64: {
      int64_t v;
      __builtin_memcpy(&v, at, sizeof v);
      wire_i64(b, v);
      break;
    }
    case WT_STR: case WT_BYTES: {
      const wire_str *v = (const wire_str *)at;
      wire_bytes(b, v->p, v->len);
      break;
    }
    case WT_STRS: {
      const wire_strs *v = (const wire_strs *)at;
      wire_u32(b, v->n);
      for (uint32_t k = 0; k < v->n; k++) wire_bytes(b, v->v[k].p, v->v[k].len);
      break;
    }
    case WT_LIST: {
      const uint8_t *items = *(const uint8_t *const *)at;
      uint32_t n = *(const uint32_t *)(in + f->off_n);
      wire_u32(b, n);
      for (uint32_t k = 0; k < n; k++) walk_write(b, f->sub, items + k * f->sub->size);
      break;
    }
    }
  }
}
void wire_encode(wire_buf *b, uint32_t kind, const void *in) {
  wire_begin(b, kind);
  walk_write(b, KINDS[kind].schema, in);
}
