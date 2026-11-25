/* The transport's ops (what was src/server/anki/transport.js's): the one shape both transports answer in, so no route knows
 * which one is live. The direct transport is the collection core (collection.h), the bridge the
 * C bridge client (bridge.h); withNormalizedPaging's hasMore from the bridge's total is here. */
#include <string.h>

#include "amgi.h"
#include "lang.h"

int ops_is_direct(const amgi_ops *o) { return !strcmp(o->t->mode, "direct"); }
#define BR (&o->t->bridge)

int ops_list_decks(arena *a, const amgi_ops *o, col_deck **out, size_t *n, col_err *e) {
  return ops_is_direct(o) ? col_list_decks(a, o->path, out, n, e) : col_bridge_list_decks(a, BR, out, n, e);
}
int ops_count_notes(arena *a, const amgi_ops *o, double deck, int64_t *out, col_err *e) {
  return ops_is_direct(o) ? col_count_notes(a, o->path, deck, out, e) : col_bridge_count_notes(a, BR, deck, out, e);
}
int ops_list_notetypes(arena *a, const amgi_ops *o, col_notetype **out, size_t *n, col_err *e) {
  return ops_is_direct(o) ? col_list_notetypes(a, o->path, out, n, e) : col_bridge_list_notetypes(a, BR, out, n, e);
}
int ops_list_notes(arena *a, const amgi_ops *o, double deck, double offset, double limit, col_page *out, col_err *e) {
  if (ops_is_direct(o)) return col_list_notes(a, o->path, deck, offset, limit, out, e);
  int64_t total = 0;
  if (col_bridge_list_notes(a, BR, deck, offset, limit, out, &total, e)) return -1;
  out->has_more = out->offset + (double)out->n < (double)total;
  return 0;
}
int ops_field_values(arena *a, const amgi_ops *o, double deck, double nt, double field, str **out, size_t *n, col_err *e) {
  return ops_is_direct(o) ? col_field_values(a, o->path, deck, nt, field, out, n, e)
                          : col_bridge_field_values(a, BR, deck, nt, field, out, n, e);
}
int ops_create_deck(arena *a, const amgi_ops *o, str name, col_deck_made *out, col_err *e) {
  return ops_is_direct(o) ? col_create_deck(a, o->path, name, out, e) : col_bridge_create_deck(a, BR, name, out, e);
}
int ops_rename_deck(arena *a, const amgi_ops *o, double deck, str name, int64_t *id, str *out_name, col_err *e) {
  if (ops_is_direct(o)) {
    col_renamed r;
    if (col_rename_deck(a, o->path, deck, name, &r, e)) return -1;
    *id = r.id, *out_name = r.name;
    return 0;
  }
  col_deck d;
  if (col_bridge_rename_deck(a, BR, deck, name, &d, e)) return -1;
  *id = d.id, *out_name = d.name;
  return 0;
}
int ops_set_deck_languages(arena *a, const amgi_ops *o, double deck, str known, str learning, col_deck_languages *out, col_err *e) {
  return ops_is_direct(o) ? col_set_deck_languages(a, o->path, deck, known, learning, out, e)
                          : col_bridge_set_deck_languages(a, BR, deck, known, learning, out, e);
}
int ops_removal_summary(arena *a, const amgi_ops *o, double deck, col_removal *out, col_err *e) {
  return ops_is_direct(o) ? col_removal_summary(a, o->path, deck, out, e) : col_bridge_removal_summary(a, BR, deck, out, e);
}
int ops_remove_deck(arena *a, const amgi_ops *o, double deck, col_removal *out, col_err *e) {
  return ops_is_direct(o) ? col_remove_deck(a, o->path, deck, out, e) : col_bridge_remove_deck(a, BR, deck, out, e);
}
int ops_add_note(arena *a, const amgi_ops *o, const col_new_note *note, col_added *out, col_err *e) {
  return ops_is_direct(o) ? col_add_note(a, o->path, note, out, e) : col_bridge_add_note(a, BR, note, out, e);
}
int ops_add_notes(arena *a, const amgi_ops *o, const col_new_note *notes, size_t n, col_added **out, size_t *nout,
                  col_err *e) {
  *out = ar_alloc(a, (n + 1) * sizeof **out);
  if (ops_is_direct(o)) {
    if (col_add_notes(a, o->path, notes, n, *out, e)) return -1;
    *nout = n;
    return 0;
  }
  return col_bridge_add_notes(a, BR, notes, n, *out, nout, e);
}
int ops_update_note(arena *a, const amgi_ops *o, double note, const str *fields, size_t nfields, int has_language,
                    str language, int has_lfi, double lfi, int *has_note_id, int64_t *note_id, int *has_warning,
                    str *warning, col_err *e) {
  if (ops_is_direct(o)) {
    *has_note_id = 0;
    return col_update_note(a, o->path, note, fields, nfields, has_language, language, has_lfi, lfi, has_warning, warning, e);
  }
  *has_note_id = 1;
  return col_bridge_update_note(a, BR, note, fields, nfields, has_language, language, has_lfi, lfi, note_id, has_warning,
                                warning, e);
}
int ops_get_note(arena *a, const amgi_ops *o, double note, col_note *out, col_err *e) {
  return ops_is_direct(o) ? col_get_note(a, o->path, note, out, e) : col_bridge_get_note(a, BR, note, out, e);
}
int ops_remove_note(arena *a, const amgi_ops *o, double note, int64_t *note_id, col_err *e) {
  int64_t removed;
  return ops_is_direct(o) ? col_remove_note(a, o->path, note, note_id, &removed, e)
                          : col_bridge_remove_note(a, BR, note, note_id, &removed, e);
}
int ops_has_media(arena *a, const amgi_ops *o, str name, int *out, col_err *e) {
  return ops_is_direct(o) ? col_has_media(a, o->path, name, out, e) : col_bridge_has_media(a, BR, name, out, e);
}
int ops_read_media(arena *a, const amgi_ops *o, str name, int *found, str *bytes, col_err *e) {
  return ops_is_direct(o) ? col_read_media(a, o->path, name, found, bytes, e) : col_bridge_read_media(a, BR, name, found, bytes, e);
}
int ops_add_media(arena *a, const amgi_ops *o, str name, const void *data, size_t len, str *stored, col_err *e) {
  return ops_is_direct(o) ? col_add_media(a, o->path, name, data, len, stored, e)
                          : col_bridge_add_media(a, BR, name, data, len, stored, e);
}

str amgi_languages_refusal(arena *a, str known, str learning) {
  if (!lang_known(known.p, (uint32_t)known.n) || !lang_known(learning.p, (uint32_t)learning.n)) {
    buf codes = {0};
    for (uint32_t i = 0; i < NLANGUAGES; i++) buf_fmt(&codes, "%s%s", i ? ", " : "", LANGUAGES[i].code);
    str msg = str_c(ar_fmt(a, "known and learning must each be one of the languages amgi has: %.*s", (int)codes.n, codes.p));
    buf_free(&codes);
    return msg;
  }
  return str_eq(known, learning) ? S("known and learning must be two different languages") : S("");
}

/* "English -> Korean": a pair as every sentence about a deck's languages names it, the table's English names (a code it does not
 * know, which a stored pair never is, is shown as it is). */
static str language_english(str code) {
  const lang_entry *l = lang_find(code.p, (uint32_t)code.n);
  return l ? str_c(l->english) : code;
}
str amgi_pair_names(arena *a, str known, str learning) {
  str k = language_english(known), l = language_english(learning);
  return str_c(ar_fmt(a, "%.*s -> %.*s", (int)k.n, k.p, (int)l.n, l.p));
}
str amgi_no_languages_refusal(void) {
  return S("This deck has no languages yet: choose them first (amgi deck add NAME --from K --to L, or Change on the deck's page).");
}
str amgi_language_mismatch_refusal(arena *a, str known, str learning, str language) {
  str pair = amgi_pair_names(a, known, learning), lang = language_english(language);
  return str_c(ar_fmt(a, "This deck is %.*s; this card is in %.*s.", (int)pair.n, pair.p, (int)lang.n, lang.p));
}
const col_deck *amgi_find_deck(const col_deck *decks, size_t n, int64_t id) {
  for (size_t i = 0; i < n; i++)
    if (decks[i].id == id) return &decks[i];
  return NULL;
}
