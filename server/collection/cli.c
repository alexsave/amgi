/* collection_cli: the C collection core behind the collection-parity runner's line protocol
 * (test/parity/protocol.mjs has the protocol; test/parity/collection-impl.mjs is the Node side of
 * it). One process is one server session: the backup ledger and the path locks live as long as it
 * does, and "parallel" runs its commands on threads, as concurrent requests reach a server.
 *
 *   AMGI_COLLECTION_IMPL=server/build/collection_cli node --test test/parity/collection.test.mjs */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bridge.h"

enum { MAX_LINES = 1 << 16 }; /* the most lines a "parallel" or "addNotesBulk" may carry */

/* The collection "open" (or a transport) named, owned by g_path_arena, and the bridge "probe" (or a
 * transport) named, owned by g_br_arena: two owners, so a probe never frees the path the direct
 * commands still use. */
static str g_path;
static arena g_path_arena;
static col_bridge g_br;
static arena g_br_arena;
/* After "probe" or "transport" picked the bridge: the commands go to it, as the bridge's ops. */
static int g_bridge;

/* ---- tokens ---- */
static int safe(unsigned char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'; }

static void enc(buf *b, str s) {
  if (!s.p) {
    buf_ch(b, '!');
    return;
  }
  if (!s.n) {
    buf_ch(b, '~');
    return;
  }
  for (size_t i = 0; i < s.n; i++) {
    unsigned char c = (unsigned char)s.p[i];
    if (safe(c)) buf_ch(b, (char)c);
    else buf_fmt(b, "%%%02X", c);
  }
}

static int hexv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 0; }

/* A text token back to its string, decoded as Node decodes bytes (invalid UTF-8 replaced); "!" is
 * absent (p NULL). */
static str dec(arena *a, str t) {
  if (t.n == 1 && t.p[0] == '!') return (str){NULL, 0};
  if (t.n == 1 && t.p[0] == '~') return S("");
  buf b = {0};
  for (size_t i = 0; i < t.n; i++) {
    if (t.p[i] == '%' && i + 2 < t.n) {
      char v = (char)(hexv(t.p[i + 1]) * 16 + hexv(t.p[i + 2]));
      buf_ch(&b, v);
      i += 2;
    } else {
      buf_ch(&b, t.p[i]);
    }
  }
  str out = utf8_clean(a, buf_str(a, &b));
  buf_free(&b);
  return out;
}

static str *split(arena *a, str s, char sep, size_t *n) {
  size_t count = 1;
  for (size_t i = 0; i < s.n; i++)
    if (s.p[i] == sep) count++;
  str *out = ar_alloc(a, count * sizeof *out);
  size_t k = 0, start = 0;
  for (size_t i = 0; i <= s.n; i++)
    if (i == s.n || s.p[i] == sep) {
      out[k++] = str_sub(s, start, i);
      start = i + 1;
    }
  *n = k;
  return out;
}

/* A list token's items (still tokens). */
static str *items(arena *a, str t, size_t *n) {
  if (t.n < 2 || t.p[0] != '[' || t.p[t.n - 1] != ']') {
    *n = 0;
    return NULL;
  }
  str inner = str_sub(t, 1, t.n - 1);
  if (!inner.n) {
    *n = 0;
    return NULL;
  }
  return split(a, inner, ',', n);
}

static str *strs_of(arena *a, str t, size_t *n) {
  str *it = items(a, t, n);
  for (size_t i = 0; i < *n; i++) it[i] = dec(a, it[i]);
  return it;
}

/* Number(token), for the decimal numbers the runner sends. */
static double num(str t) {
  char tmp[64];
  if (t.n == 0 || t.n >= sizeof tmp) return t.n == 0 ? 0 : NAN;
  memcpy(tmp, t.p, t.n);
  tmp[t.n] = 0;
  char *end;
  double v = strtod(tmp, &end);
  return *end ? NAN : v;
}

static void put_num(buf *b, double v) { js_num(b, v); }
static void put_strs(buf *b, const str *s, size_t n) {
  buf_ch(b, '[');
  for (size_t i = 0; i < n; i++) {
    if (i) buf_ch(b, ',');
    enc(b, s[i]);
  }
  buf_ch(b, ']');
}

static void put_err(buf *b, const col_err *e) {
  buf_c(b, "err ");
  if (e->kind) enc(b, str_c(e->kind));
  else if (e->status) buf_fmt(b, "%d", e->status);
  else buf_c(b, "error");
  buf_ch(b, ' ');
  enc(b, e->message);
}

static void put_added(buf *b, const col_added *r) {
  buf_fmt(b, "%lld ", (long long)r->note_id);
  enc(b, r->guid);
  buf_c(b, " [");
  for (size_t i = 0; i < r->ncards; i++) buf_fmt(b, "%s%lld", i ? "," : "", (long long)r->card_ids[i]);
  buf_c(b, "] ");
  enc(b, r->has_warning ? r->warning : (str){NULL, 0});
}

static col_new_note note_of(arena *a, str *t, size_t n) {
  col_new_note note = {0};
  if (n < 6) return note;
  note.deck_id = num(t[0]);
  note.notetype_id = num(t[1]);
  note.fields = strs_of(a, t[2], &note.nfields);
  note.tags = strs_of(a, t[3], &note.ntags);
  if (!(t[4].n == 1 && t[4].p[0] == '!')) note.has_language = 1, note.language = dec(a, t[4]);
  if (!(t[5].n == 1 && t[5].p[0] == '!')) note.has_learning_field = 1, note.learning_field = num(t[5]);
  return note;
}

static void hexbytes(buf *b, str bytes) {
  if (!bytes.n) {
    buf_ch(b, '~');
    return;
  }
  for (size_t i = 0; i < bytes.n; i++) buf_fmt(b, "%02x", (unsigned char)bytes.p[i]);
}
static str unhex(arena *a, str t) {
  if (t.n == 1 && t.p[0] == '~') return S("");
  char *p = ar_alloc(a, t.n / 2 + 1);
  for (size_t i = 0; i + 1 < t.n; i += 2) p[i / 2] = (char)(hexv(t.p[i]) * 16 + hexv(t.p[i + 1]));
  return (str){p, t.n / 2};
}

static void put_notetypes(buf *b, const col_notetype *nts, size_t nn) {
  buf_fmt(b, "ok %zu", nn);
  for (size_t i = 0; i < nn; i++) {
    buf_fmt(b, "\n%lld ", (long long)nts[i].id);
    enc(b, nts[i].name);
    buf_ch(b, ' ');
    enc(b, nts[i].cloze ? S("cloze") : S("normal"));
    buf_fmt(b, " %lld ", (long long)nts[i].sort_field);
    put_strs(b, nts[i].fields, nts[i].nfields);
    buf_c(b, " [");
    for (size_t j = 0; j < nts[i].ntemplates; j++) {
      buf rec = {0};
      buf_fmt(&rec, "%lld ", (long long)nts[i].templates[j].ord);
      enc(&rec, nts[i].templates[j].name);
      buf_ch(&rec, ' ');
      enc(&rec, nts[i].templates[j].question);
      buf_ch(&rec, ' ');
      enc(&rec, nts[i].templates[j].answer);
      if (j) buf_ch(b, ',');
      enc(b, (str){rec.p, rec.n});
      buf_free(&rec);
    }
    buf_ch(b, ']');
  }
}

static void put_page(buf *b, const col_page *p, int with_total, int64_t total) {
  buf_c(b, "ok ");
  put_num(b, p->offset);
  buf_ch(b, ' ');
  put_num(b, p->limit);
  buf_fmt(b, " %d %zu", p->has_more ? 1 : 0, p->n);
  if (with_total) buf_fmt(b, " %lld", (long long)total);
  for (size_t i = 0; i < p->n; i++) {
    buf_fmt(b, "\n%lld %lld ", (long long)p->notes[i].id, (long long)p->notes[i].notetype_id);
    put_strs(b, p->notes[i].fields, p->notes[i].nfields);
    buf_ch(b, ' ');
    put_strs(b, p->notes[i].tags, p->notes[i].ntags);
  }
}

static void put_status(buf *b, const col_bridge_status *st) {
  buf_fmt(b, " %d ", st->profile_open ? 1 : 0);
  enc(b, st->profile_name);
  buf_fmt(b, " %d ", st->collection_open ? 1 : 0);
  if (st->has_schema) buf_fmt(b, "%u ", st->schema);
  else buf_c(b, "! ");
  enc(b, st->anki_version);
  buf_ch(b, ' ');
  enc(b, st->qt_version);
}

/* The same commands through the bridge's ops: the answers have the direct ones' shapes, with what
 * the bridge does not say left out ("!" for a guid, "[]" for card ids, "!" for children renamed)
 * and listNotesInDeck's total after its count. */
static int run_bridge(arena *a, str verb, str *t, size_t n, str *more, size_t nmore, buf *b) {
  col_err e = {0};
  const col_bridge *br = &g_br;
#define ARG(i) ((i) < n ? t[i] : S(""))
  if (str_eq_c(verb, "listDecks")) {
    col_deck *d;
    size_t nd;
    if (col_bridge_list_decks(a, br, &d, &nd, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %zu", nd);
    for (size_t i = 0; i < nd; i++) {
      buf_fmt(b, "\n%lld ", (long long)d[i].id);
      enc(b, d[i].name);
    }
  } else if (str_eq_c(verb, "countNotesInDeck")) {
    int64_t count;
    if (col_bridge_count_notes(a, br, num(ARG(0)), &count, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %lld", (long long)count);
  } else if (str_eq_c(verb, "listNotetypes")) {
    col_notetype *nts;
    size_t nn;
    if (col_bridge_list_notetypes(a, br, &nts, &nn, &e)) return put_err(b, &e), 1;
    put_notetypes(b, nts, nn);
  } else if (str_eq_c(verb, "listNotesInDeck")) {
    col_page p;
    int64_t total = 0;
    if (col_bridge_list_notes(a, br, num(ARG(0)), num(ARG(1)), num(ARG(2)), &p, &total, &e)) return put_err(b, &e), 1;
    put_page(b, &p, 1, total);
  } else if (str_eq_c(verb, "existingFieldValues")) {
    str *v;
    size_t nv;
    if (col_bridge_field_values(a, br, num(ARG(0)), num(ARG(1)), num(ARG(2)), &v, &nv, &e)) return put_err(b, &e), 1;
    buf_c(b, "ok ");
    put_strs(b, v, nv);
  } else if (str_eq_c(verb, "createDeck")) {
    col_deck_made d;
    if (col_bridge_create_deck(a, br, dec(a, ARG(0)), &d, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %lld ", (long long)d.id);
    enc(b, d.name);
    buf_fmt(b, " %d", d.created ? 1 : 0);
  } else if (str_eq_c(verb, "renameDeck")) {
    col_deck r;
    if (col_bridge_rename_deck(a, br, num(ARG(0)), dec(a, ARG(1)), &r, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %lld ", (long long)r.id);
    enc(b, r.name);
    buf_c(b, " !");
  } else if (str_eq_c(verb, "deckRemovalSummary") || str_eq_c(verb, "removeDeck")) {
    col_removal r;
    int summary = str_eq_c(verb, "deckRemovalSummary");
    if ((summary ? col_bridge_removal_summary : col_bridge_remove_deck)(a, br, num(ARG(0)), &r, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %lld ", (long long)r.id);
    enc(b, r.name);
    buf_fmt(b, " %lld %lld %lld", (long long)(summary ? r.subdecks : r.decks), (long long)r.cards, (long long)r.notes);
  } else if (str_eq_c(verb, "addNote")) {
    col_new_note note = note_of(a, t, n);
    col_added r;
    if (col_bridge_add_note(a, br, &note, &r, &e)) return put_err(b, &e), 1;
    buf_c(b, "ok ");
    put_added(b, &r);
  } else if (str_eq_c(verb, "addNotesBulk")) {
    col_new_note *notes = ar_alloc(a, (nmore + 1) * sizeof *notes);
    for (size_t i = 0; i < nmore; i++) {
      size_t nt;
      str *tt = split(a, more[i], ' ', &nt);
      notes[i] = note_of(a, tt, nt);
    }
    col_added *r = ar_alloc(a, (nmore + 1) * sizeof *r);
    size_t nr;
    if (col_bridge_add_notes(a, br, notes, nmore, r, &nr, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %zu", nr);
    for (size_t i = 0; i < nr; i++) {
      buf_ch(b, '\n');
      if (r[i].ok) {
        buf_c(b, "ok ");
        put_added(b, &r[i]);
      } else {
        buf_c(b, "err ");
        enc(b, r[i].error);
      }
    }
  } else if (str_eq_c(verb, "updateNote")) {
    size_t nf;
    str *fields = strs_of(a, ARG(1), &nf);
    str lang = dec(a, ARG(2));
    int has_lfi = !(ARG(3).n == 1 && ARG(3).p[0] == '!');
    int has_w;
    int64_t id;
    str w;
    if (col_bridge_update_note(a, br, num(ARG(0)), fields, nf, lang.p != NULL, lang.p ? lang : S(""), has_lfi, num(ARG(3)), &id,
                               &has_w, &w, &e))
      return put_err(b, &e), 1;
    buf_c(b, "ok ");
    enc(b, has_w ? w : (str){NULL, 0});
  } else if (str_eq_c(verb, "removeNote")) {
    int64_t id, removed;
    if (col_bridge_remove_note(a, br, num(ARG(0)), &id, &removed, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %lld %lld", (long long)id, (long long)removed);
  } else if (str_eq_c(verb, "hasMedia")) {
    int has;
    if (col_bridge_has_media(a, br, dec(a, ARG(0)), &has, &e)) return put_err(b, &e), 1;
    buf_fmt(b, "ok %d", has ? 1 : 0);
  } else if (str_eq_c(verb, "readMedia")) {
    int found;
    str bytes = {0};
    if (col_bridge_read_media(a, br, dec(a, ARG(0)), &found, &bytes, &e)) return put_err(b, &e), 1;
    buf_c(b, "ok ");
    if (found) hexbytes(b, bytes);
    else buf_ch(b, '!');
  } else if (str_eq_c(verb, "addMedia")) {
    str data = unhex(a, ARG(1)), stored;
    if (col_bridge_add_media(a, br, dec(a, ARG(0)), data.p, data.n, &stored, &e)) return put_err(b, &e), 1;
    buf_c(b, "ok ");
    enc(b, stored);
  } else {
    return 0;
  }
#undef ARG
  return 1;
}

/* ---- one command: its answer (every line of it) into b ---- */
static void run(arena *a, str line, str *more, size_t nmore, buf *b) {
  size_t n;
  str *t = split(a, line, ' ', &n);
  str verb = t[0];
  t++, n--;
  col_err e = {0};
  if (g_bridge && run_bridge(a, verb, t, n, more, nmore, b)) return;
#define ARG(i) ((i) < n ? t[i] : S(""))
  if (str_eq_c(verb, "status")) {
    col_state s;
    if (col_status(a, g_path, &s, &e)) return put_err(b, &e);
    buf_c(b, "ok ");
    enc(b, str_c(s.status));
    if (!strcmp(s.status, "ok")) buf_fmt(b, " %d", s.schema);
    else buf_c(b, " !");
  } else if (str_eq_c(verb, "listDecks")) {
    col_deck *d;
    size_t nd;
    if (col_list_decks(a, g_path, &d, &nd, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %zu", nd);
    for (size_t i = 0; i < nd; i++) {
      buf_fmt(b, "\n%lld ", (long long)d[i].id);
      enc(b, d[i].name);
    }
  } else if (str_eq_c(verb, "countNotesInDeck")) {
    int64_t count;
    if (col_count_notes(a, g_path, num(ARG(0)), &count, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %lld", (long long)count);
  } else if (str_eq_c(verb, "listNotetypes")) {
    col_notetype *nts;
    size_t nn;
    if (col_list_notetypes(a, g_path, &nts, &nn, &e)) return put_err(b, &e);
    put_notetypes(b, nts, nn);
  } else if (str_eq_c(verb, "listNotesInDeck")) {
    col_page p;
    if (col_list_notes(a, g_path, num(ARG(0)), num(ARG(1)), num(ARG(2)), &p, &e)) return put_err(b, &e);
    put_page(b, &p, 0, 0);
  } else if (str_eq_c(verb, "existingFieldValues")) {
    str *v;
    size_t nv;
    if (col_field_values(a, g_path, num(ARG(0)), num(ARG(1)), num(ARG(2)), &v, &nv, &e)) return put_err(b, &e);
    buf_c(b, "ok ");
    put_strs(b, v, nv);
  } else if (str_eq_c(verb, "createDeck")) {
    col_deck_made d;
    if (col_create_deck(a, g_path, dec(a, ARG(0)), &d, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %lld ", (long long)d.id);
    enc(b, d.name);
    buf_fmt(b, " %d", d.created ? 1 : 0);
  } else if (str_eq_c(verb, "renameDeck")) {
    col_renamed r;
    if (col_rename_deck(a, g_path, num(ARG(0)), dec(a, ARG(1)), &r, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %lld ", (long long)r.id);
    enc(b, r.name);
    buf_fmt(b, " %lld", (long long)r.children);
  } else if (str_eq_c(verb, "deckRemovalSummary") || str_eq_c(verb, "removeDeck")) {
    col_removal r;
    int summary = str_eq_c(verb, "deckRemovalSummary");
    if ((summary ? col_removal_summary : col_remove_deck)(a, g_path, num(ARG(0)), &r, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %lld ", (long long)r.id);
    enc(b, r.name);
    buf_fmt(b, " %lld %lld %lld", (long long)(summary ? r.subdecks : r.decks), (long long)r.cards, (long long)r.notes);
  } else if (str_eq_c(verb, "addNote")) {
    col_new_note note = note_of(a, t, n);
    col_added r;
    if (col_add_note(a, g_path, &note, &r, &e)) return put_err(b, &e);
    buf_c(b, "ok ");
    put_added(b, &r);
  } else if (str_eq_c(verb, "addNotesBulk")) {
    col_new_note *notes = ar_alloc(a, (nmore + 1) * sizeof *notes);
    for (size_t i = 0; i < nmore; i++) {
      size_t nt;
      str *tt = split(a, more[i], ' ', &nt);
      notes[i] = note_of(a, tt, nt);
    }
    col_added *r = ar_alloc(a, (nmore + 1) * sizeof *r);
    if (col_add_notes(a, g_path, notes, nmore, r, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %zu", nmore);
    for (size_t i = 0; i < nmore; i++) {
      buf_ch(b, '\n');
      if (r[i].ok) {
        buf_c(b, "ok ");
        put_added(b, &r[i]);
      } else {
        buf_c(b, "err ");
        enc(b, r[i].error);
      }
    }
  } else if (str_eq_c(verb, "updateNote")) {
    size_t nf;
    str *fields = strs_of(a, ARG(1), &nf);
    str lang = dec(a, ARG(2));
    int has_lfi = !(ARG(3).n == 1 && ARG(3).p[0] == '!');
    int has_w;
    str w;
    if (col_update_note(a, g_path, num(ARG(0)), fields, nf, lang.p != NULL, lang.p ? lang : S(""), has_lfi, num(ARG(3)), &has_w, &w, &e))
      return put_err(b, &e);
    buf_c(b, "ok ");
    enc(b, has_w ? w : (str){NULL, 0});
  } else if (str_eq_c(verb, "removeNote")) {
    int64_t id, removed;
    if (col_remove_note(a, g_path, num(ARG(0)), &id, &removed, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %lld %lld", (long long)id, (long long)removed);
  } else if (str_eq_c(verb, "hasMedia")) {
    int has;
    if (col_has_media(a, g_path, dec(a, ARG(0)), &has, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %d", has ? 1 : 0);
  } else if (str_eq_c(verb, "readMedia")) {
    int found;
    str bytes = {0};
    if (col_read_media(a, g_path, dec(a, ARG(0)), &found, &bytes, &e)) return put_err(b, &e);
    buf_c(b, "ok ");
    if (found) hexbytes(b, bytes);
    else buf_ch(b, '!');
  } else if (str_eq_c(verb, "addMedia")) {
    str data = unhex(a, ARG(1)), stored;
    if (col_add_media(a, g_path, dec(a, ARG(0)), data.p, data.n, &stored, &e)) return put_err(b, &e);
    buf_c(b, "ok ");
    enc(b, stored);
  } else if (str_eq_c(verb, "createNotetype")) {
    col_spec spec = {0};
    spec.name = dec(a, ARG(0));
    spec.fields = strs_of(a, ARG(1), &spec.nfields);
    size_t nt;
    str *tt = items(a, ARG(2), &nt);
    spec.templates = ar_alloc(a, (nt + 1) * sizeof *spec.templates);
    for (size_t i = 0; i < nt; i++) {
      size_t k;
      str *parts = split(a, dec(a, tt[i]), ' ', &k);
      spec.templates[i] = (col_spec_template){dec(a, parts[0]), k > 1 ? dec(a, parts[1]) : S(""), k > 2 ? dec(a, parts[2]) : S("")};
    }
    spec.ntemplates = nt;
    spec.css = dec(a, ARG(3));
    size_t nr;
    str *rr = items(a, ARG(4), &nr);
    spec.reqs = ar_alloc(a, (nr + 1) * sizeof *spec.reqs);
    for (size_t i = 0; i < nr; i++) {
      size_t k, nords;
      str *parts = split(a, dec(a, rr[i]), ' ', &k);
      str *ords = items(a, k > 2 ? parts[2] : S("[]"), &nords);
      int64_t *o = ar_alloc(a, (nords + 1) * sizeof *o);
      for (size_t j = 0; j < nords; j++) o[j] = (int64_t)num(ords[j]);
      spec.reqs[i] = (col_requirement){(int64_t)num(parts[0]), k > 1 ? dec(a, parts[1]) : S(""), o, nords};
    }
    spec.nreqs = nr;
    size_t nm;
    str *mm = items(a, ARG(5), &nm);
    col_media *media = ar_alloc(a, (nm + 1) * sizeof *media);
    for (size_t i = 0; i < nm; i++) {
      size_t k;
      str *parts = split(a, dec(a, mm[i]), ' ', &k);
      str data = unhex(a, k > 1 ? parts[1] : S("~"));
      media[i] = (col_media){dec(a, parts[0]), data.p, data.n};
    }
    col_notetype_made r;
    if (col_create_notetype(a, g_path, &spec, media, nm, &r, &e)) return put_err(b, &e);
    buf_fmt(b, "ok %d ", r.created ? 1 : 0);
    if (r.has_id) buf_fmt(b, "%lld ", (long long)r.notetype_id);
    else buf_c(b, "! ");
    enc(b, r.reason.n ? r.reason : (str){NULL, 0});
  } else {
    buf_c(b, "err error ");
    enc(b, str_cat(a, S("unknown command "), verb));
  }
#undef ARG
}

/* ---- parallel: the commands at once, one thread each ---- */
typedef struct { str line; buf out; } job;
static void *job_run(void *arg) {
  job *j = arg;
  arena a = {0};
  run(&a, j->line, NULL, 0, &j->out);
  ar_free(&a);
  return NULL;
}

static str read_line(arena *a, int *eof) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t n = getline(&line, &cap, stdin);
  if (n < 0) {
    free(line);
    *eof = 1;
    return S("");
  }
  if (n > 0 && line[n - 1] == '\n') n--;
  str out = {ar_dup(a, line, (size_t)n), (size_t)n};
  free(line);
  return out;
}

int main(void) {
  for (;;) {
    arena a = {0};
    int eof = 0;
    str line = read_line(&a, &eof);
    if (eof || str_eq_c(line, "quit")) {
      ar_free(&a);
      break;
    }
    size_t n;
    str *t = split(&a, line, ' ', &n);
    buf out = {0};
    if (str_eq_c(t[0], "open")) {
      ar_free(&g_path_arena);
      g_path = dec(&g_path_arena, n > 1 ? t[1] : S("~"));
      g_bridge = 0;
      buf_c(&out, "ok");
    } else if (str_eq_c(t[0], "probe")) {
      /* probe <url> <token>: probeBridge; answered, the commands that follow go to the bridge. */
      ar_free(&g_br_arena);
      g_br = (col_bridge){dec(&g_br_arena, n > 1 ? t[1] : S("~")), dec(&g_br_arena, n > 2 ? t[2] : S("~"))};
      col_bridge_status st;
      col_err why;
      int probed = col_bridge_probe(&a, &g_br, &st, &why);
      g_bridge = probed == BRIDGE_ANSWERED;
      if (probed == BRIDGE_ANSWERED) {
        buf_c(&out, "ok answered");
        put_status(&out, &st);
      } else if (probed == BRIDGE_OUTDATED) {
        buf_c(&out, "ok outdated ");
        enc(&out, why.message);
      } else {
        buf_c(&out, "ok none");
      }
    } else if (str_eq_c(t[0], "transport")) {
      /* transport <collection> <url> <token> ("!" for one not set): resolveTransport; the commands
       * that follow go to whichever transport answered. */
      /* Decoded into arenas of their own, which become the session's only when the transport
       * resolves; a refused one leaves the session as it was. */
      arena path_arena = {0}, br_arena = {0};
      col_settings set;
      str coll = dec(&path_arena, n > 1 ? t[1] : S("!")), url = dec(&br_arena, n > 2 ? t[2] : S("!")), tok = dec(&br_arena, n > 3 ? t[3] : S("!"));
      set.collection_path = coll.p ? coll : S("");
      set.bridge_url = url.p ? url : S("");
      set.bridge_token = tok.p ? tok : S("");
      col_transport tr;
      col_err e;
      if (col_resolve_transport(&a, &set, &tr, &e) < 0) {
        put_err(&out, &e);
        ar_free(&path_arena);
        ar_free(&br_arena);
      } else {
        ar_free(&g_path_arena);
        ar_free(&g_br_arena);
        g_path_arena = path_arena;
        g_br_arena = br_arena;
        g_path = set.collection_path;
        g_bridge = tr.ops && !strcmp(tr.mode, "bridge");
        if (g_bridge) g_br = (col_bridge){set.bridge_url, set.bridge_token};
        buf_c(&out, "ok ");
        enc(&out, str_c(tr.mode));
        if (tr.has_schema) buf_fmt(&out, " %d", tr.schema);
        else buf_c(&out, " !");
        if (tr.has_detail) put_status(&out, &tr.detail);
      }
    } else if (str_eq_c(t[0], "addNotesBulk") || str_eq_c(t[0], "parallel")) {
      /* The runner sends a small decimal; anything else (negative, NaN, past MAX_LINES) is refused
       * before a line is read, so no cast of an unrepresentable double and no unbounded wait. */
      double want = num(n > 1 ? t[1] : S("0"));
      if (!(want >= 0 && want <= MAX_LINES && want == floor(want))) {
        buf_c(&out, "err error ");
        enc(&out, S("bad line count"));
        buf_ch(&out, '\n');
        fwrite(out.p, 1, out.n, stdout);
        fflush(stdout);
        buf_free(&out);
        ar_free(&a);
        continue;
      }
      size_t count = (size_t)want;
      str *more = ar_alloc(&a, (count + 1) * sizeof *more);
      for (size_t i = 0; i < count; i++) more[i] = read_line(&a, &eof);
      if (str_eq_c(t[0], "addNotesBulk")) {
        run(&a, line, more, count, &out);
      } else {
        job *jobs = calloc(count + 1, sizeof *jobs);
        pthread_t *th = calloc(count + 1, sizeof *th);
        if (!jobs || !th) abort();
        char *started = calloc(count + 1, 1);
        if (!started) abort();
        for (size_t i = 0; i < count; i++) {
          jobs[i].line = more[i];
          started[i] = pthread_create(&th[i], NULL, job_run, &jobs[i]) == 0;
          if (!started[i]) job_run(&jobs[i]); /* out of threads: this one runs here, in turn */
        }
        for (size_t i = 0; i < count; i++) {
          if (started[i]) pthread_join(th[i], NULL);
          if (i) buf_ch(&out, '\n');
          buf_put(&out, jobs[i].out.p ? jobs[i].out.p : "", jobs[i].out.n);
          buf_free(&jobs[i].out);
        }
        free(jobs);
        free(th);
        free(started);
      }
    } else {
      run(&a, line, NULL, 0, &out);
    }
    buf_ch(&out, '\n');
    fwrite(out.p, 1, out.n, stdout);
    fflush(stdout);
    buf_free(&out);
    ar_free(&a);
  }
  ar_free(&g_path_arena);
  ar_free(&g_br_arena);
  return 0;
}
