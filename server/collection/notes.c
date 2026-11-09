/* plusaudio/lib/collection/notes.js, notetypes.js, notetype-write.js and ids.js: notes and the
 * cards their note type's templates imply, the note types themselves, and the ids and guids Anki
 * would give them. The same statements, in the same order, as the JavaScript. */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "core.h"
#include "rng.h"

/* ---- ids.js ---- */
#define ID_EXPR(table) "(CASE WHEN ?1 IN (SELECT id FROM " table ") THEN (SELECT max(id) + 1 FROM " table ") ELSE ?1 END)"

static const char BASE91[] =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/* randomGuid: base 91 of a random 64-bit integer (big-endian from 8 random bytes), never 0. */
static str random_guid(cx *c) {
  uint64_t n = 0;
  while (n == 0) {
    uint8_t b[8];
    rng_bytes(b, 8);
    for (int i = 0; i < 8; i++) n = n << 8 | b[i];
  }
  char tmp[16];
  int k = 15;
  tmp[k] = 0;
  while (n > 0) {
    tmp[--k] = BASE91[n % 91];
    n /= 91;
  }
  return str_c(ar_dup(c->a, tmp + k, (size_t)(15 - k)));
}

/* notetype-write.js randomId: 48 random bits, big-endian, from 6 random bytes. */
static uint64_t random_id(void) {
  uint8_t b[6];
  rng_bytes(b, 6);
  uint64_t v = 0;
  for (int i = 0; i < 6; i++) v = v << 8 | b[i];
  return v;
}

/* ---- notetypes.js ---- */
static double num_or(const aj *v, double fallback) {
  if (!v || v->type == AJ_NULL) return fallback;
  return v->type == AJ_NUM ? v->num : NAN;
}
static str str_or_empty(const aj *v) { return v && v->type == AJ_STR ? v->s : S(""); }

typedef struct { double ord; str a, b, c2; size_t pos; } ordered;
/* [...list].sort((a, b) => a.ord - b.ord): stable. */
static void sort_by_ord(ordered *v, size_t n) {
  for (size_t i = 1; i < n; i++) {
    ordered x = v[i];
    size_t j = i;
    while (j > 0 && v[j - 1].ord - x.ord > 0) {
      v[j] = v[j - 1];
      j--;
    }
    v[j] = x;
  }
}

static col_notetype *read_legacy(cx *c, conn *k, size_t *n) {
  sqlite3_stmt *st = q_prep(c, k, "SELECT models FROM col");
  if (!q_step(c, k, st)) {
    q_done(st);
    cx_throw(c, NULL, 0, "Cannot read properties of undefined (reading 'models')");
  }
  str text = q_col_text(c, st, 0);
  q_done(st);
  const char *why = NULL;
  aj *models = anki_json_parse(c->a, text, &why);
  if (!models) cx_throw(c, NULL, 0, "%s", why);
  size_t nk;
  str *keys = aj_keys(c->a, models, &nk);
  col_notetype *out = ar_alloc(c->a, (nk + 1) * sizeof *out);
  for (size_t i = 0; i < nk; i++) {
    aj *m = aj_get(models, keys[i]);
    col_notetype *nt = &out[i];
    char tmp[64];
    size_t kn = keys[i].n < 63 ? keys[i].n : 63;
    memcpy(tmp, keys[i].p, kn);
    tmp[kn] = 0;
    nt->id = (int64_t)strtod(tmp, NULL);
    nt->name = str_or_empty(aj_get(m, S("name")));
    const aj *type = aj_get(m, S("type"));
    nt->cloze = type && type->type == AJ_NUM && type->num == 1;
    nt->sort_field = (int64_t)num_or(aj_get(m, S("sortf")), 0);
    const aj *flds = aj_get(m, S("flds")), *tmpls = aj_get(m, S("tmpls"));
    size_t nf = flds && flds->type == AJ_ARR ? flds->n : 0, ntm = tmpls && tmpls->type == AJ_ARR ? tmpls->n : 0;
    ordered *f = ar_alloc(c->a, (nf + 1) * sizeof *f), *t = ar_alloc(c->a, (ntm + 1) * sizeof *t);
    for (size_t j = 0; j < nf; j++)
      f[j] = (ordered){num_or(aj_get(flds->items[j], S("ord")), NAN), str_or_empty(aj_get(flds->items[j], S("name"))), {0}, {0}, j};
    for (size_t j = 0; j < ntm; j++)
      t[j] = (ordered){num_or(aj_get(tmpls->items[j], S("ord")), NAN), str_or_empty(aj_get(tmpls->items[j], S("name"))),
                       str_or_empty(aj_get(tmpls->items[j], S("qfmt"))), str_or_empty(aj_get(tmpls->items[j], S("afmt"))), j};
    sort_by_ord(f, nf);
    sort_by_ord(t, ntm);
    nt->fields = ar_alloc(c->a, (nf + 1) * sizeof(str));
    for (size_t j = 0; j < nf; j++) nt->fields[j] = f[j].a;
    nt->nfields = nf;
    nt->templates = ar_alloc(c->a, (ntm + 1) * sizeof(col_template));
    for (size_t j = 0; j < ntm; j++) nt->templates[j] = (col_template){(int64_t)t[j].ord, t[j].a, t[j].b, t[j].c2};
    nt->ntemplates = ntm;
  }
  *n = nk;
  return out;
}

typedef struct { col_notetype *nts; size_t n; } fields_args;
static col_notetype *by_id(col_notetype *nts, size_t n, int64_t id) {
  for (size_t i = 0; i < n; i++)
    if (nts[i].id == id) return &nts[i];
  return NULL;
}

/* Rows appended to a notetype's fields or templates in the order they come. */
static void push_field(cx *c, col_notetype *nt, str name) {
  str *more = ar_alloc(c->a, (nt->nfields + 1) * sizeof *more);
  if (nt->nfields) memcpy(more, nt->fields, nt->nfields * sizeof *more);
  more[nt->nfields++] = name;
  nt->fields = more;
}
static void push_template(cx *c, col_notetype *nt, col_template t) {
  col_template *more = ar_alloc(c->a, (nt->ntemplates + 1) * sizeof *more);
  if (nt->ntemplates) memcpy(more, nt->templates, nt->ntemplates * sizeof *more);
  more[nt->ntemplates++] = t;
  nt->templates = more;
}

static void read_fields_and_templates(cx *c, conn *k, void *arg) {
  fields_args *fa = arg;
  sqlite3_stmt *st = q_prep(c, k, "SELECT ntid, ord, name FROM fields");
  size_t cap = 64, n = 0;
  ordered *rows = ar_alloc(c->a, cap * sizeof *rows);
  int64_t *ntid = ar_alloc(c->a, cap * sizeof *ntid);
  while (q_step(c, k, st)) {
    if (n == cap) {
      ordered *m1 = ar_alloc(c->a, cap * 2 * sizeof *m1);
      int64_t *m2 = ar_alloc(c->a, cap * 2 * sizeof *m2);
      memcpy(m1, rows, cap * sizeof *m1), memcpy(m2, ntid, cap * sizeof *m2);
      rows = m1, ntid = m2, cap *= 2;
    }
    ntid[n] = sqlite3_column_int64(st, 0);
    rows[n] = (ordered){(double)sqlite3_column_int64(st, 1), q_col_text(c, st, 2), {0}, {0}, n};
    n++;
  }
  q_done(st);
  /* rows.sort by ord, stable: ntid travels with each row through pos. */
  sort_by_ord(rows, n);
  for (size_t i = 0; i < n; i++) {
    col_notetype *nt = by_id(fa->nts, fa->n, ntid[rows[i].pos]);
    if (nt) push_field(c, nt, rows[i].a);
  }
  st = q_prep(c, k, "SELECT ntid, ord, name, config FROM templates");
  cap = 64, n = 0;
  rows = ar_alloc(c->a, cap * sizeof *rows);
  ntid = ar_alloc(c->a, cap * sizeof *ntid);
  str *config = ar_alloc(c->a, cap * sizeof *config);
  while (q_step(c, k, st)) {
    if (n == cap) {
      ordered *m1 = ar_alloc(c->a, cap * 2 * sizeof *m1);
      int64_t *m2 = ar_alloc(c->a, cap * 2 * sizeof *m2);
      str *m3 = ar_alloc(c->a, cap * 2 * sizeof *m3);
      memcpy(m1, rows, cap * sizeof *m1), memcpy(m2, ntid, cap * sizeof *m2), memcpy(m3, config, cap * sizeof *m3);
      rows = m1, ntid = m2, config = m3, cap *= 2;
    }
    ntid[n] = sqlite3_column_int64(st, 0);
    rows[n] = (ordered){(double)sqlite3_column_int64(st, 1), q_col_text(c, st, 2), {0}, {0}, n};
    config[n] = q_col_blob(c, st, 3);
    n++;
  }
  q_done(st);
  sort_by_ord(rows, n);
  for (size_t i = 0; i < n; i++) {
    col_notetype *nt = by_id(fa->nts, fa->n, ntid[rows[i].pos]);
    if (!nt) continue;
    /* Template.Config: question (1) and answer (2); no varint is read. */
    str cfg = config[rows[i].pos];
    col_template t = {(int64_t)rows[i].ord, rows[i].a, S(""), S("")};
    size_t at = 0;
    pb_field f;
    while (pb_next(c, (const unsigned char *)cfg.p, cfg.n, &at, 0, &f)) {
      if (f.wire != 2) continue;
      str text = utf8_clean(c->a, (str){(const char *)f.bytes, f.len});
      if (f.number == 1) t.question = text;
      else if (f.number == 2) t.answer = text;
    }
    push_template(c, nt, t);
  }
}

col_notetype *read_notetypes(cx *c, conn *k, size_t *n) {
  if (k->schema == 11) return read_legacy(c, k, n);
  sqlite3_stmt *st = q_prep(c, k, "SELECT id, name, config FROM notetypes");
  size_t cap = 16;
  col_notetype *out = ar_alloc(c->a, cap * sizeof *out);
  *n = 0;
  while (q_step(c, k, st)) {
    if (*n == cap) {
      col_notetype *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more;
      cap *= 2;
    }
    col_notetype *nt = &out[(*n)++];
    memset(nt, 0, sizeof *nt);
    nt->id = sqlite3_column_int64(st, 0);
    nt->name = q_col_text(c, st, 1);
    str cfg = q_col_blob(c, st, 2);
    /* Notetype.Config: kind (1) and sort field (2), the only varints read. */
    size_t at = 0;
    pb_field f;
    while (pb_next(c, (const unsigned char *)cfg.p, cfg.n, &at, (1u << 1) | (1u << 2), &f)) {
      if (f.wire != 0) continue;
      if (f.number == 1) nt->cloze = f.value == 1;
      else if (f.number == 2) nt->sort_field = (int64_t)f.value;
    }
  }
  q_done(st);
  fields_args fa = {out, *n};
  read_fields_and_templates(c, k, &fa);
  return out;
}

/* ---- notes.js ---- */
static str js_number(cx *c, double v) {
  buf b = {0};
  js_num(&b, v);
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

static str romanization_warning(cx *c, const col_notetype *nt, const str *fields, size_t nfields, int has_language,
                                str language, int has_lfi, double lfi) {
  if (!has_language || language.n == 0 || !has_lfi || !isfinite(lfi) || lfi != trunc(lfi)) return (str){NULL, 0};
  str text = lfi >= 0 && lfi < (double)nfields ? fields[(size_t)lfi] : S("");
  if (!looks_romanized(c, text, language)) return (str){NULL, 0};
  str name = lfi >= 0 && lfi < (double)nt->nfields ? nt->fields[(size_t)lfi] : str_cat(c->a, S("field "), js_number(c, lfi));
  return str_c(ar_fmt(c->a, "\"%.*s\" looks fully romanised for a %.*s note - check it is not meant to be written in %.*s's own script.",
                      (int)name.n, name.p, (int)language.n, language.p, (int)language.n, language.p));
}

static void touch_mod(cx *c, conn *k) {
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, now_ms());
  q_run(c, k, st);
}

/* nextCardPosition: col.conf's nextPos (schema 11), the config table's (schema 18). */
static aj *plus_one(cx *c, const aj *pos) {
  return aj_num(c->a, (pos && pos->type == AJ_NUM ? pos->num : 0) + 1);
}
static double pos_of(const aj *pos) { return pos && pos->type == AJ_NUM ? pos->num : 1; }

static double next_card_position(cx *c, conn *k) {
  if (k->schema == 11) {
    sqlite3_stmt *st = q_prep(c, k, "SELECT conf FROM col");
    if (!q_step(c, k, st)) {
      q_done(st);
      cx_throw(c, NULL, 0, "Cannot read properties of undefined (reading 'conf')");
    }
    str text = q_col_text(c, st, 0);
    q_done(st);
    const char *why = NULL;
    aj *conf = anki_json_parse(c->a, text, &why);
    if (!conf) cx_throw(c, NULL, 0, "%s", why);
    const aj *got = aj_get(conf, S("nextPos"));
    const aj *pos = got && got->type != AJ_NULL ? got : NULL;
    double p = pos_of(pos);
    aj_set(c->a, conf, S("nextPos"), plus_one(c, pos ? pos : aj_num(c->a, 1)));
    st = q_prep(c, k, "UPDATE col SET conf = ? WHERE id = 1");
    q_text(st, 1, anki_json_stringify(c->a, conf));
    q_run(c, k, st);
    return p;
  }
  sqlite3_stmt *st = q_prep(c, k, "SELECT val FROM config WHERE KEY = 'nextPos'");
  aj *pos = aj_num(c->a, 1);
  if (q_step(c, k, st)) {
    str val = utf8_clean(c->a, q_col_blob(c, st, 0));
    q_done(st);
    const char *why = NULL;
    pos = anki_json_parse(c->a, val, &why);
    if (!pos) cx_throw(c, NULL, 0, "%s", why);
  } else {
    q_done(st);
  }
  str next = anki_json_stringify(c->a, plus_one(c, pos));
  st = q_prep(c, k,
              "INSERT INTO config (KEY, usn, mtime_secs, val) VALUES ('nextPos', -1, ?, ?) "
              "ON CONFLICT(KEY) DO UPDATE SET usn = -1, mtime_secs = excluded.mtime_secs, val = excluded.val");
  q_int(st, 1, now_ms() / 1000);
  q_blob(st, 2, next.p, next.n);
  q_run(c, k, st);
  return pos_of(pos);
}

static const col_notetype *find_notetype(const col_notetype *nts, size_t n, double id) {
  for (size_t i = 0; i < n; i++)
    if ((double)nts[i].id == id) return &nts[i];
  return NULL;
}

static void field_count_error(cx *c, const col_notetype *nt, size_t got) {
  cx_throw(c, NULL, 0, "note type \"%.*s\" has %zu fields, got %zu", (int)nt->name.n, nt->name.p, nt->nfields, got);
}

void note_insert(cx *c, conn *k, const col_notetype *nts, size_t nnt, const col_new_note *note, col_added *out) {
  str *fields = anki_fields(c, note->fields, note->nfields);
  const col_notetype *nt = find_notetype(nts, nnt, note->notetype_id);
  if (!nt) {
    str id = js_number(c, note->notetype_id);
    cx_throw(c, NULL, 0, "no note type with id %.*s in this collection", (int)id.n, id.p);
  }
  if (note->nfields != nt->nfields) field_count_error(c, nt, note->nfields);
  str warning = romanization_warning(c, nt, fields, note->nfields, note->has_language, note->language,
                                     note->has_learning_field, note->learning_field);
  double now = floor((double)now_ms() / 1000);
  str guid = random_guid(c);
  str flds = join_fields(c, fields, note->nfields);
  str sort_src = nt->sort_field >= 0 && (size_t)nt->sort_field < note->nfields ? fields[nt->sort_field] : S("");
  str sort_text = strip_html_preserving_media(c, sort_src);
  int64_t csum = field_checksum(c, strip_html_preserving_media(c, note->nfields ? fields[0] : S("")));
  str tags = S("");
  if (note->ntags) {
    buf b = {0};
    for (size_t i = 0; i < note->ntags; i++) {
      buf_ch(&b, ' ');
      buf_s(&b, note->tags[i]);
    }
    buf_ch(&b, ' ');
    tags = buf_str(c->a, &b);
    buf_free(&b);
  }
  sqlite3_stmt *st = q_prep(c, k,
                            "\n  INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)\n"
                            "  VALUES (" ID_EXPR("notes") ", ?, ?, ?, ?, ?, ?, ?, ?, 0, '')\n");
  q_int(st, 1, now_ms());
  q_text(st, 2, guid);
  q_num(st, 3, note->notetype_id);
  q_num(st, 4, now);
  q_int(st, 5, -1);
  q_text(st, 6, tags);
  q_text(st, 7, flds);
  q_text(st, 8, sort_text);
  q_int(st, 9, csum);
  q_run(c, k, st);
  int64_t note_id = sqlite3_last_insert_rowid(k->db);
  int64_t *ords;
  size_t nords = ordinals_for_new_note(c, nt, fields, note->nfields, note->ntags, &ords);
  int64_t *cards = ar_alloc(c->a, (nords + 1) * sizeof *cards);
  sqlite3_stmt *ins = NULL;
  for (size_t i = 0; i < nords; i++) {
    double due = next_card_position(c, k);
    if (!ins)
      ins = q_prep(c, k,
                   "\n  INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)\n"
                   "  VALUES (" ID_EXPR("cards") ", ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')\n");
    q_int(ins, 1, now_ms());
    q_int(ins, 2, note_id);
    q_num(ins, 3, note->deck_id);
    q_int(ins, 4, ords[i]);
    q_num(ins, 5, now);
    q_num(ins, 6, due);
    q_run(c, k, ins);
    cards[i] = sqlite3_last_insert_rowid(k->db);
  }
  out->ok = 1;
  out->note_id = note_id;
  out->guid = guid;
  out->card_ids = cards;
  out->ncards = nords;
  out->has_warning = warning.p != NULL;
  out->warning = warning;
}

void note_update(cx *c, conn *k, double note_id, const str *given, size_t ngiven, int has_language, str language,
                 int has_lfi, double lfi, int *has_warning, str *warning) {
  str *fields = anki_fields(c, given, ngiven);
  sqlite3_stmt *st = q_prep(c, k, "SELECT mid FROM notes WHERE id = ?");
  q_num(st, 1, note_id);
  if (!q_step(c, k, st)) {
    q_done(st);
    str id = js_number(c, note_id);
    cx_throw(c, NULL, 0, "no note with id %.*s in this collection", (int)id.n, id.p);
  }
  int64_t mid = sqlite3_column_int64(st, 0);
  q_done(st);
  size_t nnt;
  col_notetype *nts = read_notetypes(c, k, &nnt);
  const col_notetype *nt = find_notetype(nts, nnt, (double)mid);
  if (!nt) {
    str id = js_number(c, note_id);
    cx_throw(c, NULL, 0, "note %.*s has an unknown note type", (int)id.n, id.p);
  }
  if (ngiven != nt->nfields) field_count_error(c, nt, ngiven);
  str w = romanization_warning(c, nt, fields, ngiven, has_language, language, has_lfi, lfi);
  double now = floor((double)now_ms() / 1000);
  str flds = join_fields(c, fields, ngiven);
  str sort_src = nt->sort_field >= 0 && (size_t)nt->sort_field < ngiven ? fields[nt->sort_field] : S("");
  str sort_text = strip_html_preserving_media(c, sort_src);
  int64_t csum = field_checksum(c, strip_html_preserving_media(c, ngiven ? fields[0] : S("")));
  st = q_prep(c, k, "\n  UPDATE notes SET mod = ?, usn = -1, flds = ?, sfld = ?, csum = ? WHERE id = ?\n");
  q_num(st, 1, now);
  q_text(st, 2, flds);
  q_text(st, 3, sort_text);
  q_int(st, 4, csum);
  q_num(st, 5, note_id);
  q_run(c, k, st);
  touch_mod(c, k);
  *has_warning = w.p != NULL;
  *warning = w;
}

void note_remove(cx *c, conn *k, double note_id, int64_t *out_id, int64_t *removed) {
  sqlite3_stmt *st = q_prep(c, k, "SELECT id FROM notes WHERE id = ?");
  q_num(st, 1, note_id);
  int found = q_step(c, k, st);
  q_done(st);
  if (!found) {
    str id = js_number(c, note_id);
    cx_throw(c, NULL, 0, "no note with id %.*s in this collection", (int)id.n, id.p);
  }
  st = q_prep(c, k, "SELECT id FROM cards WHERE nid = ?");
  q_num(st, 1, note_id);
  size_t cap = 8, n = 0;
  int64_t *cards = ar_alloc(c->a, cap * sizeof *cards);
  while (q_step(c, k, st)) {
    if (n == cap) {
      int64_t *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, cards, cap * sizeof *more);
      cards = more;
      cap *= 2;
    }
    cards[n++] = sqlite3_column_int64(st, 0);
  }
  q_done(st);
  sqlite3_stmt *grave = q_prep(c, k, "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, ?)");
  for (size_t i = 0; i < n; i++) {
    q_int(grave, 1, cards[i]);
    q_int(grave, 2, 0);
    q_run(c, k, grave);
  }
  q_num(grave, 1, note_id);
  q_int(grave, 2, 1);
  q_run(c, k, grave);
  st = q_prep(c, k, "DELETE FROM cards WHERE nid = ?");
  q_num(st, 1, note_id);
  q_run(c, k, st);
  st = q_prep(c, k, "DELETE FROM notes WHERE id = ?");
  q_num(st, 1, note_id);
  q_run(c, k, st);
  touch_mod(c, k);
  *out_id = (int64_t)note_id;
  *removed = (int64_t)n;
}

/* The listing reads: deck and subdecks, through their cards. */
static sqlite3_stmt *deck_query(cx *c, conn *k, const char *head, const char *tail, double deck, size_t *bound) {
  size_t n;
  double *ids = deck_and_child_ids(c, k, deck, &n);
  buf b = {0};
  for (size_t i = 0; i < n; i++) buf_c(&b, i ? ",?" : "?");
  const char *sql = ar_fmt(c->a, "%s%.*s%s", head, (int)b.n, b.p ? b.p : "", tail);
  buf_free(&b);
  sqlite3_stmt *st = q_prep(c, k, sql);
  for (size_t i = 0; i < n; i++) q_num(st, (int)i + 1, ids[i]);
  *bound = n;
  return st;
}

void notes_count(cx *c, conn *k, double deck, int64_t *out) {
  size_t n;
  sqlite3_stmt *st = deck_query(c, k,
                                "SELECT COUNT(DISTINCT n.id) AS total FROM notes n JOIN cards c ON c.nid = n.id\n"
                                "         WHERE c.did IN (",
                                ")", deck, &n);
  q_step(c, k, st);
  *out = sqlite3_column_int64(st, 0);
  q_done(st);
}

/* tags.trim().split(/\s+/), or none. */
static str *split_tags(cx *c, str tags, size_t *n) {
  str t = js_trim(tags);
  *n = 0;
  if (!t.n) return NULL;
  str *out = ar_alloc(c->a, (t.n / 2 + 2) * sizeof *out);
  size_t i = 0;
  while (i < t.n) {
    size_t start = i;
    for (;;) {
      if (i >= t.n) break;
      size_t at = i;
      if (js_space(utf8_next(t, &at))) break;
      i = at;
    }
    out[(*n)++] = str_sub(t, start, i);
    while (i < t.n) {
      size_t at = i;
      if (!js_space(utf8_next(t, &at))) break;
      i = at;
    }
  }
  return out;
}

void notes_page(cx *c, conn *k, double deck, double offset, double limit, col_note **out, size_t *nout) {
  size_t n;
  sqlite3_stmt *st = deck_query(c, k,
                                "SELECT DISTINCT n.id, n.mid, n.flds, n.tags\n"
                                "         FROM notes n JOIN cards c ON c.nid = n.id\n"
                                "         WHERE c.did IN (",
                                ")\n         ORDER BY n.id\n         LIMIT ? OFFSET ?", deck, &n);
  q_num(st, (int)n + 1, limit);
  q_num(st, (int)n + 2, offset);
  size_t cap = 16;
  col_note *notes = ar_alloc(c->a, cap * sizeof *notes);
  *nout = 0;
  while (q_step(c, k, st)) {
    if (*nout == cap) {
      col_note *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, notes, cap * sizeof *more);
      notes = more;
      cap *= 2;
    }
    col_note *nt = &notes[(*nout)++];
    nt->id = sqlite3_column_int64(st, 0);
    nt->notetype_id = sqlite3_column_int64(st, 1);
    nt->fields = split_fields(c, q_col_text(c, st, 2), &nt->nfields);
    nt->tags = split_tags(c, q_col_text(c, st, 3), &nt->ntags);
  }
  q_done(st);
  *out = notes;
}

void field_values(cx *c, conn *k, double deck, double notetype, double field, str **out, size_t *nout) {
  size_t n;
  sqlite3_stmt *st = deck_query(c, k,
                                "SELECT DISTINCT n.id, n.flds\n"
                                "         FROM notes n JOIN cards c ON c.nid = n.id\n"
                                "         WHERE c.did IN (",
                                ") AND n.mid = ?", deck, &n);
  q_num(st, (int)n + 1, notetype);
  size_t cap = 16;
  str *vals = ar_alloc(c->a, cap * sizeof *vals);
  *nout = 0;
  while (q_step(c, k, st)) {
    if (*nout == cap) {
      str *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, vals, cap * sizeof *more);
      vals = more;
      cap *= 2;
    }
    size_t nf;
    str *fields = split_fields(c, q_col_text(c, st, 1), &nf);
    int in = isfinite(field) && field == trunc(field) && field >= 0 && field < (double)nf;
    vals[(*nout)++] = in ? fields[(size_t)field] : S("");
  }
  q_done(st);
  *out = vals;
}

/* ---- notetype-write.js ---- */
#define DEFAULT_LATEX_PRE                                                                     \
  "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n" \
  "\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n"
#define DEFAULT_LATEX_POST "\\end{document}"

void spec_validate(cx *c, const col_spec *spec) {
  if (!spec->name.n) cx_throw(c, NULL, 0, "a note type needs a name");
  if (!spec->nfields) cx_throw(c, NULL, 0, "a note type needs fields");
  for (size_t i = 0; i < spec->nfields; i++)
    for (size_t j = i + 1; j < spec->nfields; j++)
      if (str_eq(js_lower(c->a, spec->fields[i]), js_lower(c->a, spec->fields[j]))) cx_throw(c, NULL, 0, "field names must be unique");
  if (!spec->ntemplates) cx_throw(c, NULL, 0, "a note type needs a card template");
}

typedef struct { const col_spec *spec; int64_t now; int64_t id; } nt_args;

static void encode_config(cx *c, const col_spec *spec, buf *b) {
  pb_bytes_field(b, 3, spec->css.p, spec->css.n);
  pb_bytes_field(b, 5, DEFAULT_LATEX_PRE, sizeof DEFAULT_LATEX_PRE - 1);
  pb_bytes_field(b, 6, DEFAULT_LATEX_POST, sizeof DEFAULT_LATEX_POST - 1);
  for (size_t i = 0; i < spec->nreqs; i++) {
    const col_requirement *r = &spec->reqs[i];
    int kind = str_eq_c(r->kind, "none") ? 0 : str_eq_c(r->kind, "any") ? 1 : str_eq_c(r->kind, "all") ? 2 : -1;
    if (kind < 0) cx_throw(c, NULL, 0, "unknown card requirement kind %.*s", (int)r->kind.n, r->kind.p);
    buf req = {0}, packed = {0};
    if (r->ord) pb_varint_field(&req, 1, (uint64_t)r->ord);
    if (kind) pb_varint_field(&req, 2, (uint64_t)kind);
    for (size_t j = 0; j < r->nfields; j++) pb_varint(&packed, (uint64_t)r->fields[j]);
    if (r->nfields) pb_bytes_field(&req, 3, packed.p, packed.n);
    pb_bytes_field(b, 8, req.p ? req.p : "", req.n);
    buf_free(&req);
    buf_free(&packed);
  }
  pb_varint_field(b, 9, 1);
}

static void create_rows(cx *c, conn *k, void *arg) {
  nt_args *na = arg;
  const col_spec *spec = na->spec;
  /* In the caller's one transaction (direct.c with_write). */
  buf cfg = {0};
  encode_config(c, spec, &cfg);
  str config = buf_str(c->a, &cfg);
  buf_free(&cfg);
  sqlite3_stmt *st = q_prep(c, k, "INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (" ID_EXPR("notetypes") ", ?2, ?3, -1, ?4) RETURNING id");
  q_int(st, 1, na->now);
  q_text(st, 2, spec->name);
  q_int(st, 3, na->now / 1000);
  q_blob(st, 4, config.p, config.n);
  q_step(c, k, st);
  na->id = sqlite3_column_int64(st, 0);
  q_done(st);
  sqlite3_stmt *f = q_prep(c, k, "INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)");
  for (size_t i = 0; i < spec->nfields; i++) {
    buf fc = {0};
    pb_bytes_field(&fc, 3, "Arial", 5);
    pb_varint_field(&fc, 4, 20);
    pb_varint_field(&fc, 9, random_id());
    q_int(f, 1, na->id);
    q_int(f, 2, (int64_t)i);
    q_text(f, 3, spec->fields[i]);
    q_blob(f, 4, fc.p, fc.n);
    q_run(c, k, f);
    buf_free(&fc);
  }
  sqlite3_stmt *t = q_prep(c, k, "INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, 0, ?)");
  for (size_t i = 0; i < spec->ntemplates; i++) {
    buf tc = {0};
    pb_bytes_field(&tc, 1, spec->templates[i].front.p, spec->templates[i].front.n);
    pb_bytes_field(&tc, 2, spec->templates[i].back.p, spec->templates[i].back.n);
    pb_varint_field(&tc, 8, random_id());
    q_int(t, 1, na->id);
    q_int(t, 2, (int64_t)i);
    q_text(t, 3, spec->templates[i].name);
    q_blob(t, 4, tc.p, tc.n);
    q_run(c, k, t);
    buf_free(&tc);
  }
  st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, na->now);
  q_run(c, k, st);
}

/* Installing the note type is the write the page makes by itself, on every load until it is there
 * (amgi's automatic install), with no person in the loop: it takes a backup of its own first, even
 * when the session already has one, and only when it will really write. */
void notetype_create(cx *c, conn *k, str path, const col_spec *spec, col_notetype_made *out) {
  memset(out, 0, sizeof *out);
  if (k->schema == 11) {
    out->reason = S("legacy-schema");
    return;
  }
  sqlite3_stmt *st = q_prep(c, k, "SELECT id, name FROM notetypes");
  str want = js_lower(c->a, spec->name);
  while (q_step(c, k, st)) {
    if (str_eq(js_lower(c->a, q_col_text(c, st, 1)), want)) {
      out->reason = S("exists");
      out->has_id = 1;
      out->notetype_id = sqlite3_column_int64(st, 0);
      q_done(st);
      return;
    }
  }
  q_done(st);
  ensure_fresh_backup_on(c, path, k);
  nt_args na = {spec, now_ms(), 0};
  create_rows(c, k, &na);
  out->created = 1;
  out->has_id = 1;
  out->notetype_id = na.id;
}
