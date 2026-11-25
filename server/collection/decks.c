/* plusaudio/lib/collection/decks.js and deck-remove.js: listing, creating, renaming and deleting
 * decks in both schemas. Their module comments hold the reasoning (unicase, the relaxed collation,
 * what Anki's remove_decks does); this is the same code, in the same order, so it writes the same
 * rows. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "core.h"
#include "lang.h"

#define DEFAULT_DECK_ID 1
#define FILTERED_KIND_TAG 0x12
#define UNIX_EPOCH_DUE 1000000000

static const unsigned char DEFAULT_COMMON_BLOB[] = {0x08, 0x01, 0x10, 0x01};
static const unsigned char DEFAULT_KIND_BLOB[] = {0x0a, 0x02, 0x08, 0x01};

/* ---- names ---- */
/* name.rs normalized_deck_name_component: NFC, no control characters, no leading or trailing
 * whitespace or colons, "blank" when nothing is left. */
static str normalize_component(cx *c, str component) {
  str nfc = js_nfc(c->a, component);
  buf b = {0};
  for (size_t at = 0; at < nfc.n;) {
    size_t from = at;
    uint32_t cp = utf8_next(nfc, &at);
    if (cp <= 0x1f || cp == 0x7f) continue;
    buf_put(&b, nfc.p + from, at - from);
  }
  str s = buf_str(c->a, &b);
  buf_free(&b);
  /* /^[\s:]+|[\s:]+$/g */
  size_t start = 0, end = s.n;
  while (start < end) {
    size_t at = start;
    uint32_t cp = utf8_next(s, &at);
    if (!(cp == ':' || js_space(cp))) break;
    start = at;
  }
  while (end > start) {
    size_t k = end - 1;
    while (k > start && ((unsigned char)s.p[k] & 0xc0) == 0x80) k--;
    size_t at = k;
    uint32_t cp = utf8_next(s, &at);
    if (!(cp == ':' || js_space(cp))) break;
    end = k;
  }
  str out = str_sub(s, start, end);
  return out.n ? out : S("blank");
}

str *human_name_to_components(cx *c, str human, size_t *n) {
  size_t count = 1;
  for (size_t i = 0; i + 1 < human.n; i++)
    if (human.p[i] == ':' && human.p[i + 1] == ':') count++, i++;
  str *out = ar_alloc(c->a, count * sizeof *out);
  size_t k = 0, start = 0;
  for (size_t i = 0; i <= human.n; i++) {
    if (i == human.n || (i + 1 < human.n && human.p[i] == ':' && human.p[i + 1] == ':')) {
      out[k++] = normalize_component(c, str_sub(human, start, i));
      if (i == human.n) break;
      start = i + 2;
      i++;
    }
  }
  *n = k;
  return out;
}

static str join_with(cx *c, const str *parts, size_t n, str sep) {
  buf b = {0};
  for (size_t i = 0; i < n; i++) {
    if (i) buf_s(&b, sep);
    buf_s(&b, parts[i]);
  }
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* foldKey, as unicase folds: the names Anki's collation calls equal fold the same, so a find, a
 * rename's "taken" check and the subdeck prefix agree with the unique index on decks.name. (The
 * JavaScript lower-cased, which misses "ß" against "SS" and the ligatures; the PR #30 review,
 * finding 1, once the collation is real.) */
str fold_key(cx *c, str name) { return case_fold(c->a, js_nfc(c->a, name)); }

/* "\x1f" (schema 18's separator) as "::", and back. */
static str replace_all(cx *c, str s, str from, str to) {
  buf b = {0};
  for (size_t i = 0; i < s.n;) {
    if (s.n - i >= from.n && !memcmp(s.p + i, from.p, from.n)) {
      buf_s(&b, to);
      i += from.n;
    } else {
      buf_ch(&b, s.p[i++]);
    }
  }
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}
static str human_of_native(cx *c, str native) { return replace_all(c, native, S("\x1f"), S("::")); }

/* ---- ids ---- */
typedef struct { double *v; size_t n, cap; } idset;
static void ids_add(cx *c, idset *s, double v) {
  if (s->n == s->cap) {
    size_t cap = s->cap ? s->cap * 2 : 16;
    double *more = ar_alloc(c->a, cap * sizeof *more);
    if (s->n) memcpy(more, s->v, s->n * sizeof *more);
    s->v = more;
    s->cap = cap;
  }
  s->v[s->n++] = v;
}
static int ids_has(const idset *s, double v) {
  for (size_t i = 0; i < s->n; i++)
    if (s->v[i] == v) return 1;
  return 0;
}
/* allocId: wanted, or one past the largest taken when wanted is taken. */
static double alloc_id(const idset *s, double wanted) {
  if (!ids_has(s, wanted)) return wanted;
  double max = wanted;
  for (size_t i = 0; i < s->n; i++)
    if (s->v[i] > max) max = s->v[i];
  return max + 1;
}

/* ---- schema 11: col.decks ---- */
static aj *read_col_value(cx *c, conn *k, const char *column) {
  char sql[64];
  snprintf(sql, sizeof sql, "SELECT %s FROM col", column);
  sqlite3_stmt *st = q_prep(c, k, sql);
  if (!q_step(c, k, st)) {
    q_done(st);
    cx_throw(c, NULL, 0, "Cannot read properties of undefined (reading '%s')", column);
  }
  str text = q_col_text(c, st, 0);
  q_done(st);
  const char *why = NULL;
  aj *v = anki_json_parse(c->a, text, &why);
  if (!v) cx_throw(c, NULL, 0, "%s", why);
  return v;
}

static aj *new_deck_value(cx *c, double id, str name, double mtime) {
  aj *d = aj_obj(c->a);
  aj *pair[4];
  for (int i = 0; i < 4; i++) {
    pair[i] = aj_arr(c->a);
    aj_push(c->a, pair[i], aj_num(c->a, 0));
    aj_push(c->a, pair[i], aj_num(c->a, 0));
  }
  aj_set(c->a, d, S("id"), aj_num(c->a, id));
  aj_set(c->a, d, S("mod"), aj_num(c->a, mtime));
  aj_set(c->a, d, S("name"), aj_str(c->a, name));
  aj_set(c->a, d, S("usn"), aj_num(c->a, -1));
  aj_set(c->a, d, S("lrnToday"), pair[0]);
  aj_set(c->a, d, S("revToday"), pair[1]);
  aj_set(c->a, d, S("newToday"), pair[2]);
  aj_set(c->a, d, S("timeToday"), pair[3]);
  aj_set(c->a, d, S("collapsed"), aj_bool(c->a, 1));
  aj_set(c->a, d, S("browserCollapsed"), aj_bool(c->a, 1));
  aj_set(c->a, d, S("desc"), aj_str(c->a, S("")));
  aj_set(c->a, d, S("dyn"), aj_num(c->a, 0));
  aj_set(c->a, d, S("conf"), aj_num(c->a, 1));
  aj_set(c->a, d, S("extendNew"), aj_num(c->a, 0));
  aj_set(c->a, d, S("extendRev"), aj_num(c->a, 0));
  aj_set(c->a, d, S("reviewLimit"), aj_null(c->a));
  aj_set(c->a, d, S("newLimit"), aj_null(c->a));
  aj_set(c->a, d, S("reviewLimitToday"), aj_null(c->a));
  aj_set(c->a, d, S("newLimitToday"), aj_null(c->a));
  aj_set(c->a, d, S("desiredRetention"), aj_null(c->a));
  return d;
}

/* A JavaScript value as Number() of it: a number, or NaN. */
static double num_of(const aj *v) {
  if (!v) return NAN;
  if (v->type == AJ_NUM) return v->num;
  if (v->type == AJ_BOOL) return v->b;
  if (v->type == AJ_NULL) return 0;
  if (v->type == AJ_STR) {
    str t = js_trim(v->s);
    if (!t.n) return 0;
    char *end;
    char tmp[64];
    if (t.n >= sizeof tmp) return NAN;
    memcpy(tmp, t.p, t.n);
    tmp[t.n] = 0;
    double d = strtod(tmp, &end);
    return *end ? NAN : d;
  }
  return NAN;
}
static str str_of(const aj *v) { return v && v->type == AJ_STR ? v->s : S(""); }

/* Object.values(col.decks), with each deck's id and name. */
static aj **object_values(cx *c, const aj *obj, size_t *n) {
  str *keys = aj_keys(c->a, obj, n);
  aj **out = ar_alloc(c->a, (*n + 1) * sizeof *out);
  for (size_t i = 0; i < *n; i++) out[i] = aj_get(obj, keys[i]);
  return out;
}

static str id_key(cx *c, double id) {
  buf b = {0};
  js_num(&b, id);
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* ---- a deck's language pair ----
 * It is one key of the deck's own add-on area, where Anki keeps every key it does not know and where an
 * add-on's `deck["key"] = ...; col.decks.save(deck)` writes: "amgiLanguages": "<known> <learning>", one
 * string, the two codes of lang.h with one space between them ("en zh_cn"). Schema 11 has it as a key of
 * the deck's dict in col.decks, which this file parses and rewrites whole anyway (every schema 11 write
 * does), so the pair is set there with the quarantine's parser. Schema 18 has the area as JSON text in
 * field 255 (`other`) of the deck's `common` protobuf, and there nothing is parsed: a scanner walks the
 * top-level object, skipping every value uninterpreted, to find this one key's value; a write changes only
 * that value's bytes, so every other add-on's bytes (1.0, escapes, nested objects) stay as they were.
 * Anything that is not that string (an object, a number, extra spaces, an unknown code, the same code
 * twice) reads as no pair. */
#define PAIR_KEY "amgiLanguages"
#define OTHER_FIELD 255

/* "<known> <learning>" (text, with no escapes left) as two different known codes, or no pair. */
static void pair_split(str v, str *known, str *learning) {
  *known = *learning = S("");
  const char *sp = memchr(v.p, ' ', v.n);
  if (!sp) return;
  str k = {v.p, (size_t)(sp - v.p)}, l = {sp + 1, v.n - k.n - 1};
  if (!lang_pair_ok(k.p, (uint32_t)k.n, l.p, (uint32_t)l.n)) return;
  *known = k, *learning = l;
}

/* schema 11: the deck dict's value */
static void pair_of(const aj *v, str *known, str *learning) {
  *known = *learning = S("");
  if (v && v->type == AJ_STR) pair_split(v->s, known, learning);
}

static aj *pair_value(cx *c, str known, str learning) {
  return aj_str(c->a, str_cat(c->a, str_cat(c->a, known, S(" ")), learning));
}

/* ---- schema 18's add-on area: one scan, no parse ---- */
static size_t skip_ws(str t, size_t i) {
  while (i < t.n && (t.p[i] == ' ' || t.p[i] == '\t' || t.p[i] == '\n' || t.p[i] == '\r')) i++;
  return i;
}
/* Past the string whose opening quote is at i, or 0 when it never ends. */
static size_t skip_string(str t, size_t i) {
  for (i++; i < t.n; i++) {
    if (t.p[i] == '\\') i++;
    else if (t.p[i] == '"') return i + 1;
  }
  return 0;
}
/* Past the value that starts at i (a string; an object or array, strings inside it skipped; or a number or
 * literal up to the next separator), or 0 when there is none or it never ends. Its inside is not checked. */
static size_t skip_value(str t, size_t i) {
  if (i >= t.n) return 0;
  if (t.p[i] == '"') return skip_string(t, i);
  if (t.p[i] == '{' || t.p[i] == '[') {
    int depth = 0;
    for (; i < t.n; i++) {
      if (t.p[i] == '"') {
        if (!(i = skip_string(t, i))) return 0;
        i--;
      } else if (t.p[i] == '{' || t.p[i] == '[') depth++;
      else if ((t.p[i] == '}' || t.p[i] == ']') && --depth == 0) return i + 1;
    }
    return 0;
  }
  size_t from = i;
  while (i < t.n && !strchr(",}] \t\r\n", t.p[i])) i++;
  return i > from ? i : 0;
}

/* Where the area's top-level key PAIR_KEY has its value (the last one, as a JSON reader takes it), and where the
 * object closes. 0 when the text is not an object at the top level. */
typedef struct { size_t vs, ve; int found; size_t close; int empty; } area;
static int area_scan(str t, area *r) {
  memset(r, 0, sizeof *r);
  size_t i = skip_ws(t, 0);
  if (i >= t.n || t.p[i] != '{') return 0;
  i = skip_ws(t, i + 1);
  if (i < t.n && t.p[i] == '}') r->empty = 1;
  while (i < t.n && t.p[i] != '}') {
    if (t.p[i] != '"') return 0;
    size_t ke = skip_string(t, i);
    if (!ke) return 0;
    str key = {t.p + i + 1, ke - i - 2};
    i = skip_ws(t, ke);
    if (i >= t.n || t.p[i] != ':') return 0;
    i = skip_ws(t, i + 1);
    size_t ve = skip_value(t, i);
    if (!ve) return 0;
    if (str_eq_c(key, PAIR_KEY)) r->vs = i, r->ve = ve, r->found = 1;
    i = skip_ws(t, ve);
    if (i < t.n && t.p[i] == ',') i = skip_ws(t, i + 1);
    else if (i >= t.n || t.p[i] != '}') return 0;
  }
  if (i >= t.n) return 0;
  r->close = i;
  return skip_ws(t, i + 1) == t.n;
}

/* The last field 255 of a `common` blob. */
typedef struct { str common, other; int has; } other_scan;
static void other_scan_body(cx *c, void *arg) {
  other_scan *o = arg;
  size_t at = 0;
  pb_field f;
  while (pb_next(c, (const unsigned char *)o->common.p, o->common.n, &at, 0, &f))
    if (f.number == OTHER_FIELD && f.wire == 2) o->other = (str){(const char *)f.bytes, f.len}, o->has = 1;
}

/* A listing never fails over one deck's blob: a malformed one has no pair. The value must be a string with no
 * backslash in it. */
static void pair_18(cx *c, str common, str *known, str *learning) {
  other_scan o = {common, S(""), 0};
  area r;
  *known = *learning = S("");
  if (cx_try(c, other_scan_body, &o) || !o.has || !area_scan(o.other, &r) || !r.found) return;
  str v = {o.other.p + r.vs, r.ve - r.vs};
  if (v.n < 2 || v.p[0] != '"' || v.p[v.n - 1] != '"' || memchr(v.p, '\\', v.n)) return;
  pair_split((str){v.p + 1, v.n - 2}, known, learning);
}

/* `common` with amgi's key set in field 255 and everything else as it was: every other field is copied
 * byte for byte in its order, then field 255 last (Anki's encoder writes in number order, and 255 is the
 * highest). In the area only the key's value changes (or the key is added before the closing brace); an
 * area that is absent is `{"amgiLanguages":"..."}`, and one that is not an object is refused rather than
 * overwritten: it is another add-on's. */
static str common_with_pair(cx *c, str common, str known, str learning) {
  other_scan o = {common, S(""), 0};
  if (cx_try(c, other_scan_body, &o)) cx_rethrow(c);
  str value = str_cat(c->a, str_cat(c->a, str_cat(c->a, S("\""), known), str_cat(c->a, S(" "), learning)), S("\""));
  str json;
  if (!o.has) {
    json = str_cat(c->a, str_cat(c->a, S("{\"" PAIR_KEY "\":"), value), S("}"));
  } else {
    area r;
    if (!area_scan(o.other, &r)) cx_throw(c, NULL, 0, "the deck's add-on data is not a JSON object: nothing was written");
    str t = o.other;
    if (r.found) {
      json = str_cat(c->a, str_cat(c->a, str_sub(t, 0, r.vs), value), str_sub(t, r.ve, t.n));
    } else {
      str add = str_cat(c->a, str_cat(c->a, r.empty ? S("") : S(","), S("\"" PAIR_KEY "\":")), value);
      /* before the closing brace, after the last value (not after the whitespace that follows it) */
      size_t at = r.close;
      while (at > 0 && (t.p[at - 1] == ' ' || t.p[at - 1] == '\t' || t.p[at - 1] == '\n' || t.p[at - 1] == '\r')) at--;
      if (r.empty) at = skip_ws(t, 0) + 1;
      json = str_cat(c->a, str_cat(c->a, str_sub(t, 0, at), add), str_sub(t, at, t.n));
    }
  }
  buf out = {0};
  size_t at = 0, from = 0;
  pb_field f;
  while (pb_next(c, (const unsigned char *)common.p, common.n, &at, 0, &f)) {
    if (f.number != OTHER_FIELD) buf_put(&out, common.p + from, at - from);
    from = at;
  }
  pb_bytes_field(&out, OTHER_FIELD, json.p, json.n);
  str result = buf_str(c->a, &out);
  buf_free(&out);
  return result;
}

deck_row *list_decks_for_schema(cx *c, conn *k, size_t *n, aj **json_out) {
  if (k->schema == 11) {
    aj *decks = read_col_value(c, k, "decks");
    if (json_out) *json_out = decks;
    aj **vals = object_values(c, decks, n);
    deck_row *out = ar_alloc(c->a, (*n + 1) * sizeof *out);
    for (size_t i = 0; i < *n; i++) {
      out[i].id = (int64_t)num_of(aj_get(vals[i], S("id")));
      out[i].name = str_of(aj_get(vals[i], S("name")));
      const aj *dyn = aj_get(vals[i], S("dyn"));
      out[i].filtered = dyn && dyn->type == AJ_NUM && dyn->num == 1;
      pair_of(aj_get(vals[i], S(PAIR_KEY)), &out[i].known, &out[i].learning);
    }
    return out;
  }
  sqlite3_stmt *st = q_prep(c, k, "SELECT id, name, kind, common FROM decks");
  size_t cap = 32;
  deck_row *out = ar_alloc(c->a, cap * sizeof *out);
  *n = 0;
  while (q_step(c, k, st)) {
    if (*n == cap) {
      deck_row *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more;
      cap *= 2;
    }
    str kind = q_col_blob(c, st, 2);
    out[*n].id = sqlite3_column_int64(st, 0);
    out[*n].name = human_of_native(c, q_col_text(c, st, 1));
    out[*n].filtered = kind.n > 0 && (unsigned char)kind.p[0] == FILTERED_KIND_TAG;
    pair_18(c, q_col_blob(c, st, 3), &out[*n].known, &out[*n].learning);
    (*n)++;
  }
  q_done(st);
  return out;
}

double *deck_and_child_ids(cx *c, conn *k, double deck_id, size_t *n) {
  size_t nd;
  deck_row *all = list_decks_for_schema(c, k, &nd, NULL);
  double *out = ar_alloc(c->a, (nd + 1) * sizeof *out);
  const deck_row *target = NULL;
  for (size_t i = 0; i < nd && !target; i++)
    if ((double)all[i].id == deck_id) target = &all[i];
  out[0] = deck_id;
  *n = 1;
  if (!target) return out;
  str prefix = str_cat(c->a, fold_key(c, target->name), S("::"));
  for (size_t i = 0; i < nd; i++)
    if ((double)all[i].id != deck_id && str_starts(fold_key(c, all[i].name), prefix)) out[(*n)++] = (double)all[i].id;
  return out;
}

/* ---- create ---- */
typedef struct { double id; str native, key; } to_create;
typedef struct { to_create *list; size_t n; double now; } insert_args;

static void insert_decks(cx *c, conn *k, void *arg) {
  insert_args *ia = arg;
  sqlite3_stmt *ins = q_prep(c, k, "INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)");
  for (size_t i = 0; i < ia->n; i++) {
    q_num(ins, 1, ia->list[i].id);
    q_text(ins, 2, ia->list[i].native);
    q_num(ins, 3, ia->now);
    q_blob(ins, 4, DEFAULT_COMMON_BLOB, sizeof DEFAULT_COMMON_BLOB);
    q_blob(ins, 5, DEFAULT_KIND_BLOB, sizeof DEFAULT_KIND_BLOB);
    q_run(c, k, ins);
  }
}

static void create_legacy(cx *c, conn *k, str human, double now, col_deck_made *out) {
  aj *decks = read_col_value(c, k, "decks");
  size_t nv;
  aj **vals = object_values(c, decks, &nv);
  /* byFold: a Map of fold -> deck, a later deck replacing an earlier one with the same fold. */
  size_t cap = nv + 16, nf = 0;
  str *folds = ar_alloc(c->a, cap * sizeof *folds);
  aj **fdeck = ar_alloc(c->a, cap * sizeof *fdeck);
  idset ids = {0};
  for (size_t i = 0; i < nv; i++) {
    str f = fold_key(c, str_of(aj_get(vals[i], S("name"))));
    size_t j = 0;
    while (j < nf && !str_eq(folds[j], f)) j++;
    if (j == nf) folds[nf++] = f;
    fdeck[j] = vals[i];
    ids_add(c, &ids, num_of(aj_get(vals[i], S("id"))));
  }
  size_t nc;
  str *comp = human_name_to_components(c, human, &nc);
  int created = 0;
  for (size_t len = 1; len <= nc; len++) {
    str name = join_with(c, comp, len, S("::"));
    str f = fold_key(c, name);
    size_t j = 0;
    while (j < nf && !str_eq(folds[j], f)) j++;
    if (j < nf) continue;
    double id = alloc_id(&ids, (double)now_ms());
    ids_add(c, &ids, id);
    aj *deck = new_deck_value(c, id, name, now);
    aj_set(c->a, decks, id_key(c, id), deck);
    if (nf == cap) cx_throw(c, NULL, 0, "too many decks");
    folds[nf] = f;
    fdeck[nf++] = deck;
    created = 1;
  }
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET decks = ?, mod = ? WHERE id = 1");
  q_text(st, 1, anki_json_stringify(c->a, decks));
  q_int(st, 2, now_ms());
  q_run(c, k, st);
  str f = fold_key(c, join_with(c, comp, nc, S("::")));
  for (size_t j = 0; j < nf; j++)
    if (str_eq(folds[j], f)) {
      out->id = (int64_t)num_of(aj_get(fdeck[j], S("id")));
      out->name = str_of(aj_get(fdeck[j], S("name")));
    }
  out->created = created;
}

static void create_18(cx *c, conn *k, str human, double now, col_deck_made *out) {
  sqlite3_stmt *st = q_prep(c, k, "SELECT id, name FROM decks");
  size_t cap = 64, nr = 0;
  int64_t *rid = ar_alloc(c->a, cap * sizeof *rid);
  str *rname = ar_alloc(c->a, cap * sizeof *rname), *rfold = ar_alloc(c->a, cap * sizeof *rfold);
  idset ids = {0};
  while (q_step(c, k, st)) {
    if (nr == cap) {
      int64_t *a1 = ar_alloc(c->a, cap * 2 * sizeof *a1);
      str *a2 = ar_alloc(c->a, cap * 2 * sizeof *a2), *a3 = ar_alloc(c->a, cap * 2 * sizeof *a3);
      memcpy(a1, rid, cap * sizeof *a1), memcpy(a2, rname, cap * sizeof *a2), memcpy(a3, rfold, cap * sizeof *a3);
      rid = a1, rname = a2, rfold = a3, cap *= 2;
    }
    rid[nr] = sqlite3_column_int64(st, 0);
    rname[nr] = q_col_text(c, st, 1);
    rfold[nr] = fold_key(c, human_of_native(c, rname[nr]));
    ids_add(c, &ids, (double)rid[nr]);
    nr++;
  }
  q_done(st);
  /* byFold.get: the last row with that fold. */
  size_t nc;
  str *comp = human_name_to_components(c, human, &nc);
  to_create *list = ar_alloc(c->a, (nc + 1) * sizeof *list);
  size_t nl = 0;
  for (size_t len = 1; len <= nc; len++) {
    str key = fold_key(c, join_with(c, comp, len, S("::")));
    int found = 0;
    for (size_t j = 0; j < nr; j++)
      if (str_eq(rfold[j], key)) found = 1;
    if (found) continue;
    double id = alloc_id(&ids, (double)(now_ms() + (int64_t)nl));
    ids_add(c, &ids, id);
    list[nl++] = (to_create){id, join_with(c, comp, len, S("\x1f")), key};
  }
  if (nl == 0) {
    str key = fold_key(c, join_with(c, comp, nc, S("::")));
    for (size_t j = 0; j < nr; j++)
      if (str_eq(rfold[j], key)) out->id = rid[j], out->name = human_of_native(c, rname[j]);
    out->created = 0;
    return;
  }
  insert_args ia = {list, nl, now};
  insert_decks(c, k, &ia);
  st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, now_ms());
  q_run(c, k, st);
  out->id = (int64_t)list[nl - 1].id;
  out->name = human_of_native(c, list[nl - 1].native);
  out->created = 1;
}

void deck_create(cx *c, conn *k, str human, col_deck_made *out) {
  double now = floor((double)now_ms() / 1000);
  if (k->schema == 11) create_legacy(c, k, human, now, out);
  else create_18(c, k, human, now, out);
}

/* ---- rename ---- */
typedef struct {
  str *ancestors;
  size_t nanc;
  idset *ids;
  double now;
  str native;
  int64_t current;
  str current_name;
  int64_t *children;
  str *child_names;
  size_t nchildren;
} rename_args;

static void rename_rows(cx *c, conn *k, void *arg) {
  rename_args *r = arg;
  /* The renamed decks move first, then the missing parents are made: a parent spelled like the
   * deck's old name ("BIRNE" for "Birne") is the same name to the unique index until it moves. */
  sqlite3_stmt *up = q_prep(c, k, "UPDATE decks SET name = ?, mtime_secs = ?, usn = -1 WHERE id = ?");
  q_text(up, 1, r->native);
  q_num(up, 2, r->now);
  q_int(up, 3, r->current);
  q_run(c, k, up);
  for (size_t i = 0; i < r->nchildren; i++) {
    q_text(up, 1, str_cat(c->a, r->native, str_sub(r->child_names[i], r->current_name.n, r->child_names[i].n)));
    q_num(up, 2, r->now);
    q_int(up, 3, r->children[i]);
    q_run(c, k, up);
  }
  sqlite3_stmt *ins = q_prep(c, k, "INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)");
  for (size_t i = 0; i < r->nanc; i++) {
    double id = alloc_id(r->ids, (double)now_ms());
    ids_add(c, r->ids, id);
    q_num(ins, 1, id);
    q_text(ins, 2, r->ancestors[i]);
    q_num(ins, 3, r->now);
    q_blob(ins, 4, DEFAULT_COMMON_BLOB, sizeof DEFAULT_COMMON_BLOB);
    q_blob(ins, 5, DEFAULT_KIND_BLOB, sizeof DEFAULT_KIND_BLOB);
    q_run(c, k, ins);
  }
}

static str js_id(cx *c, double v) { return id_key(c, v); }

static void rename_18(cx *c, conn *k, double deck_id, str human, double now, col_renamed *out) {
  sqlite3_stmt *st = q_prep(c, k, "SELECT id, name FROM decks");
  size_t cap = 64, nr = 0;
  int64_t *rid = ar_alloc(c->a, cap * sizeof *rid);
  str *rname = ar_alloc(c->a, cap * sizeof *rname);
  while (q_step(c, k, st)) {
    if (nr == cap) {
      int64_t *a1 = ar_alloc(c->a, cap * 2 * sizeof *a1);
      str *a2 = ar_alloc(c->a, cap * 2 * sizeof *a2);
      memcpy(a1, rid, cap * sizeof *a1), memcpy(a2, rname, cap * sizeof *a2);
      rid = a1, rname = a2, cap *= 2;
    }
    rid[nr] = sqlite3_column_int64(st, 0);
    rname[nr] = q_col_text(c, st, 1);
    nr++;
  }
  q_done(st);
  ssize_t cur = -1;
  for (size_t i = 0; i < nr && cur < 0; i++)
    if ((double)rid[i] == deck_id) cur = (ssize_t)i;
  if (cur < 0) {
    str id = js_id(c, deck_id);
    cx_throw(c, NULL, 0, "no deck with id %.*s in this collection", (int)id.n, id.p);
  }
  size_t nc;
  str *comp = human_name_to_components(c, human, &nc);
  str native = join_with(c, comp, nc, S("\x1f"));
  str nfold = fold_key(c, native);
  for (size_t i = 0; i < nr; i++)
    if ((double)rid[i] != deck_id && str_eq(fold_key(c, rname[i]), nfold)) {
      str h = join_with(c, comp, nc, S("::"));
      cx_throw(c, NULL, 0, "a deck called \"%.*s\" already exists", (int)h.n, h.p);
    }
  str old_prefix = str_cat(c->a, rname[cur], S("\x1f"));
  rename_args r = {0};
  r.children = ar_alloc(c->a, (nr + 1) * sizeof *r.children);
  r.child_names = ar_alloc(c->a, (nr + 1) * sizeof *r.child_names);
  for (size_t i = 0; i < nr; i++)
    if (str_starts(rname[i], old_prefix)) r.children[r.nchildren] = rid[i], r.child_names[r.nchildren++] = rname[i];
  idset ids = {0};
  for (size_t i = 0; i < nr; i++) ids_add(c, &ids, (double)rid[i]);
  r.ancestors = ar_alloc(c->a, (nc + 1) * sizeof *r.ancestors);
  for (size_t len = 1; len < nc; len++) {
    str anc = join_with(c, comp, len, S("\x1f"));
    str af = fold_key(c, anc);
    int found = 0;
    /* The deck being renamed and its subdecks are moving: none of them is the new name's parent
     * (renaming "Birne" to "BIRNE::Öl" needs a new "BIRNE", as Anki makes one; the JavaScript
     * counted the deck as its own parent and left the new name with none). */
    for (size_t i = 0; i < nr; i++)
      if (i != (size_t)cur && !str_starts(rname[i], old_prefix) && str_eq(fold_key(c, rname[i]), af)) found = 1;
    if (!found) r.ancestors[r.nanc++] = anc;
  }
  r.ids = &ids;
  r.now = now;
  r.native = native;
  r.current = rid[cur];
  r.current_name = rname[cur];
  rename_rows(c, k, &r);
  st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, now_ms());
  q_run(c, k, st);
  out->id = (int64_t)deck_id;
  out->name = join_with(c, comp, nc, S("::"));
  out->children = (int64_t)r.nchildren;
}

static void rename_legacy(cx *c, conn *k, double deck_id, str human, double now, col_renamed *out) {
  aj *decks = read_col_value(c, k, "decks");
  aj *current = aj_get(decks, id_key(c, deck_id));
  if (!current) {
    str id = js_id(c, deck_id);
    cx_throw(c, NULL, 0, "no deck with id %.*s in this collection", (int)id.n, id.p);
  }
  size_t nc;
  str *comp = human_name_to_components(c, human, &nc);
  str name = join_with(c, comp, nc, S("::"));
  size_t nv;
  aj **vals = object_values(c, decks, &nv);
  double cur_id = num_of(aj_get(current, S("id")));
  str nfold = fold_key(c, name);
  for (size_t i = 0; i < nv; i++) {
    /* deck.id !== current.id: strict, so a deck whose id is not a number is never "current". */
    const aj *vid = aj_get(vals[i], S("id")), *cid = aj_get(current, S("id"));
    int same = vid && cid && vid->type == AJ_NUM && cid->type == AJ_NUM && vid->num == cid->num;
    if (!same && str_eq(fold_key(c, str_of(aj_get(vals[i], S("name")))), nfold))
      cx_throw(c, NULL, 0, "a deck called \"%.*s\" already exists", (int)name.n, name.p);
  }
  str cur_name = str_of(aj_get(current, S("name")));
  str old_prefix = str_cat(c->a, cur_name, S("::"));
  int64_t renamed = 0;
  for (size_t i = 0; i < nv; i++) {
    const aj *vid = aj_get(vals[i], S("id"));
    if (vid && vid->type == AJ_NUM && vid->num == cur_id) continue;
    str dn = str_of(aj_get(vals[i], S("name")));
    if (!str_starts(dn, old_prefix)) continue;
    aj_set(c->a, vals[i], S("name"), aj_str(c->a, str_cat(c->a, name, str_sub(dn, cur_name.n, dn.n))));
    aj_set(c->a, vals[i], S("mod"), aj_num(c->a, now));
    aj_set(c->a, vals[i], S("usn"), aj_num(c->a, -1));
    renamed++;
  }
  aj_set(c->a, current, S("name"), aj_str(c->a, name));
  aj_set(c->a, current, S("mod"), aj_num(c->a, now));
  aj_set(c->a, current, S("usn"), aj_num(c->a, -1));
  /* A subdeck needs its parent: the missing ancestors, made as new decks. */
  vals = object_values(c, decks, &nv);
  size_t cap = nv + nc + 1, nf = 0;
  str *folds = ar_alloc(c->a, cap * sizeof *folds);
  idset ids = {0};
  for (size_t i = 0; i < nv; i++) {
    folds[nf++] = fold_key(c, str_of(aj_get(vals[i], S("name"))));
    ids_add(c, &ids, num_of(aj_get(vals[i], S("id"))));
  }
  size_t nc2;
  str *comp2 = human_name_to_components(c, human, &nc2);
  for (size_t len = 1; len < nc2; len++) {
    str anc = join_with(c, comp2, len, S("::"));
    str af = fold_key(c, anc);
    int found = 0;
    for (size_t j = 0; j < nf; j++)
      if (str_eq(folds[j], af)) found = 1;
    if (found) continue;
    double id = alloc_id(&ids, (double)now_ms());
    ids_add(c, &ids, id);
    aj_set(c->a, decks, id_key(c, id), new_deck_value(c, id, anc, now));
    folds[nf++] = af;
  }
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET decks = ?, mod = ? WHERE id = 1");
  q_text(st, 1, anki_json_stringify(c->a, decks));
  q_int(st, 2, now_ms());
  q_run(c, k, st);
  out->id = (int64_t)deck_id;
  out->name = name;
  out->children = renamed;
}

void deck_rename(cx *c, conn *k, double deck_id, str human, col_renamed *out) {
  double now = floor((double)now_ms() / 1000);
  if (k->schema == 11) rename_legacy(c, k, deck_id, human, now, out);
  else rename_18(c, k, deck_id, human, now, out);
}

/* ---- a deck's language pair, written ---- */
static _Noreturn void no_deck(cx *c, double deck_id) {
  str id = id_key(c, deck_id);
  cx_throw(c, NULL, 404, "no deck with id %.*s in this collection", (int)id.n, id.p);
}

/* As a rename writes: the deck's mtime_secs now and usn -1 (schema 11: its dict's mod and usn), and col.mod
 * moved, because a sync that sees no newer col.mod reports no changes and the other device never gets
 * the pair. */
void deck_set_languages(cx *c, conn *k, double deck_id, str known, str learning, col_deck_languages *out) {
  double now = floor((double)now_ms() / 1000);
  if (k->schema == 11) {
    aj *decks = read_col_value(c, k, "decks");
    aj *deck = aj_get(decks, id_key(c, deck_id));
    if (!deck) no_deck(c, deck_id);
    aj_set(c->a, deck, S(PAIR_KEY), pair_value(c, known, learning));
    aj_set(c->a, deck, S("mod"), aj_num(c->a, now));
    aj_set(c->a, deck, S("usn"), aj_num(c->a, -1));
    sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET decks = ?, mod = ? WHERE id = 1");
    q_text(st, 1, anki_json_stringify(c->a, decks));
    q_int(st, 2, now_ms());
    q_run(c, k, st);
  } else {
    sqlite3_stmt *st = q_prep(c, k, "SELECT common FROM decks WHERE id = ?");
    q_num(st, 1, deck_id);
    if (!q_step(c, k, st)) {
      q_done(st);
      no_deck(c, deck_id);
    }
    str common = q_col_blob(c, st, 0);
    q_done(st);
    str next = common_with_pair(c, common, known, learning);
    st = q_prep(c, k, "UPDATE decks SET common = ?, mtime_secs = ?, usn = -1 WHERE id = ?");
    q_blob(st, 1, next.p, next.n);
    q_num(st, 2, now);
    q_num(st, 3, deck_id);
    q_run(c, k, st);
    st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
    q_int(st, 1, now_ms());
    q_run(c, k, st);
  }
  out->id = (int64_t)deck_id;
  out->known = known;
  out->learning = learning;
}

/* ---- deck-remove.js ---- */
typedef struct {
  deck_row target;
  deck_row *tree;
  size_t ntree;
  int64_t *cards, *notes;
  size_t ncards, nnotes;
  struct { int64_t id, odid, odue, due, type, queue; } *returned;
  size_t nreturned;
  aj *json;
} plan_t;

static int by_name(const void *x, const void *y) {
  const deck_row *a = x, *b = y;
  return js_cmp(a->name, b->name);
}

static str placeholders(cx *c, size_t n) {
  buf b = {0};
  for (size_t i = 0; i < n; i++) buf_c(&b, i ? ",?" : "?");
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* `(<t>.did IN (list) OR (<t>.odid != 0 AND <t>.odid IN (list)))` */
static str goes(cx *c, const char *t, str list) {
  return str_c(ar_fmt(c->a, "(%s.did IN (%.*s) OR (%s.odid != 0 AND %s.odid IN (%.*s)))", t, (int)list.n, list.p, t, t,
                      (int)list.n, list.p));
}

static void bind_ids(sqlite3_stmt *st, int *at, const int64_t *ids, size_t n) {
  for (size_t i = 0; i < n; i++) q_int(st, (*at)++, ids[i]);
}

static int64_t *collect(cx *c, conn *k, sqlite3_stmt *st, size_t *n) {
  size_t cap = 32;
  int64_t *out = ar_alloc(c->a, cap * sizeof *out);
  *n = 0;
  while (q_step(c, k, st)) {
    if (*n == cap) {
      int64_t *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more;
      cap *= 2;
    }
    out[(*n)++] = sqlite3_column_int64(st, 0);
  }
  q_done(st);
  return out;
}

/* A sort that keeps equal names in their order, as Array.prototype.sort does. */
static void stable_sort(deck_row *rows, size_t n) {
  for (size_t i = 1; i < n; i++) {
    deck_row x = rows[i];
    size_t j = i;
    while (j > 0 && by_name(&rows[j - 1], &x) > 0) {
      rows[j] = rows[j - 1];
      j--;
    }
    rows[j] = x;
  }
}

static int plan(cx *c, conn *k, double deck_id, plan_t *p) {
  memset(p, 0, sizeof *p);
  size_t nd;
  deck_row *decks = list_decks_for_schema(c, k, &nd, &p->json);
  ssize_t t = -1;
  for (size_t i = 0; i < nd && t < 0; i++)
    if ((double)decks[i].id == deck_id) t = (ssize_t)i;
  if (t < 0) return 0;
  p->target = decks[t];
  str prefix = str_cat(c->a, fold_key(c, p->target.name), S("::"));
  deck_row *children = ar_alloc(c->a, (nd + 1) * sizeof *children);
  size_t nch = 0;
  for (size_t i = 0; i < nd; i++)
    if (decks[i].id != p->target.id && str_starts(fold_key(c, decks[i].name), prefix)) children[nch++] = decks[i];
  stable_sort(children, nch);
  p->tree = ar_alloc(c->a, (nch + 2) * sizeof *p->tree);
  p->tree[0] = p->target;
  memcpy(p->tree + 1, children, nch * sizeof *children);
  p->ntree = nch + 1;
  int64_t *normal = ar_alloc(c->a, (p->ntree + 1) * sizeof *normal), *filtered = ar_alloc(c->a, (p->ntree + 1) * sizeof *filtered);
  size_t nn = 0, nf = 0;
  for (size_t i = 0; i < p->ntree; i++) {
    if (p->tree[i].filtered) filtered[nf++] = p->tree[i].id;
    else normal[nn++] = p->tree[i].id;
  }
  str list = placeholders(c, nn);
  str gc = goes(c, "c", list), go = goes(c, "o", list);
  sqlite3_stmt *st = q_prep(c, k, ar_fmt(c->a, "SELECT c.id FROM cards c WHERE %.*s", (int)gc.n, gc.p));
  int at = 1;
  bind_ids(st, &at, normal, nn);
  bind_ids(st, &at, normal, nn);
  p->cards = collect(c, k, st, &p->ncards);
  st = q_prep(c, k, ar_fmt(c->a,
                           "SELECT DISTINCT c.nid FROM cards c WHERE %.*s\n"
                           "       AND NOT EXISTS (SELECT 1 FROM cards o WHERE o.nid = c.nid AND NOT %.*s)",
                           (int)gc.n, gc.p, (int)go.n, go.p));
  at = 1;
  for (int r = 0; r < 4; r++) bind_ids(st, &at, normal, nn);
  p->notes = collect(c, k, st, &p->nnotes);
  str flist = placeholders(c, nf);
  st = q_prep(c, k, ar_fmt(c->a,
                           "SELECT c.id, c.odid, c.odue, c.due, c.type, c.queue FROM cards c\n"
                           "       WHERE c.did IN (%.*s) AND NOT %.*s",
                           (int)flist.n, flist.p, (int)gc.n, gc.p));
  at = 1;
  bind_ids(st, &at, filtered, nf);
  bind_ids(st, &at, normal, nn);
  bind_ids(st, &at, normal, nn);
  size_t cap = 16;
  p->returned = ar_alloc(c->a, cap * sizeof *p->returned);
  while (q_step(c, k, st)) {
    if (p->nreturned == cap) {
      void *more = ar_alloc(c->a, cap * 2 * sizeof *p->returned);
      memcpy(more, p->returned, cap * sizeof *p->returned);
      p->returned = more;
      cap *= 2;
    }
    p->returned[p->nreturned].id = sqlite3_column_int64(st, 0);
    p->returned[p->nreturned].odid = sqlite3_column_int64(st, 1);
    p->returned[p->nreturned].odue = sqlite3_column_int64(st, 2);
    p->returned[p->nreturned].due = sqlite3_column_int64(st, 3);
    p->returned[p->nreturned].type = sqlite3_column_int64(st, 4);
    p->returned[p->nreturned].queue = sqlite3_column_int64(st, 5);
    p->nreturned++;
  }
  q_done(st);
  return 1;
}

static void not_there(cx *c, double deck_id) {
  str id = js_id(c, deck_id);
  cx_throw(c, NULL, 404, "no deck with id %.*s in this collection", (int)id.n, id.p);
}

void deck_summary(cx *c, conn *k, double deck_id, col_removal *out) {
  plan_t p;
  if (!plan(c, k, deck_id, &p)) not_there(c, deck_id);
  out->id = p.target.id;
  out->name = p.target.name;
  out->subdecks = (int64_t)p.ntree - 1;
  out->cards = (int64_t)p.ncards;
  out->notes = (int64_t)p.nnotes;
}

static void return_home(cx *c, conn *k, plan_t *p, double now) {
  sqlite3_stmt *up = q_prep(c, k, "UPDATE cards SET did = ?, odid = 0, due = ?, odue = 0, queue = ?, mod = ?, usn = -1 WHERE id = ?");
  sqlite3_stmt *touch = q_prep(c, k, "UPDATE cards SET mod = ?, usn = -1 WHERE id = ?");
  for (size_t i = 0; i < p->nreturned; i++) {
    if (p->returned[i].odid == 0) {
      q_num(touch, 1, now);
      q_int(touch, 2, p->returned[i].id);
      q_run(c, k, touch);
      continue;
    }
    int64_t due = p->returned[i].odue != 0 ? p->returned[i].odue : p->returned[i].due;
    int64_t queue = p->returned[i].queue;
    if (queue >= 0) {
      int64_t type = p->returned[i].type;
      queue = type == 1 || type == 3 ? (due > UNIX_EPOCH_DUE ? 1 : 3) : type;
    }
    q_int(up, 1, p->returned[i].odid);
    q_int(up, 2, due);
    q_int(up, 3, queue);
    q_num(up, 4, now);
    q_int(up, 5, p->returned[i].id);
    q_run(c, k, up);
  }
}

static sqlite3_stmt *remove_rows(cx *c, conn *k, plan_t *p) {
  sqlite3_stmt *grave = q_prep(c, k, "INSERT OR IGNORE INTO graves (usn, oid, type) VALUES (-1, ?, ?)");
  sqlite3_stmt *del_card = q_prep(c, k, "DELETE FROM cards WHERE id = ?");
  for (size_t i = 0; i < p->ncards; i++) {
    q_int(grave, 1, p->cards[i]);
    q_int(grave, 2, 0);
    q_run(c, k, grave);
    q_int(del_card, 1, p->cards[i]);
    q_run(c, k, del_card);
  }
  sqlite3_stmt *del_note = q_prep(c, k, "DELETE FROM notes WHERE id = ?");
  for (size_t i = 0; i < p->nnotes; i++) {
    q_int(del_note, 1, p->notes[i]);
    q_run(c, k, del_note);
    q_int(grave, 1, p->notes[i]);
    q_int(grave, 2, 1);
    q_run(c, k, grave);
  }
  return grave;
}

typedef struct { plan_t *p; double now; sqlite3_stmt *grave; str *index; size_t nindex; } remove18_args;
static void remove_decks_18(cx *c, conn *k, void *arg) {
  remove18_args *r = arg;
  sqlite3_stmt *del = q_prep(c, k, "DELETE FROM decks WHERE id = ?");
  sqlite3_stmt *reset = q_prep(c, k, "UPDATE decks SET name = ?, mtime_secs = ?, usn = -1 WHERE id = ?");
  for (size_t i = 0; i < r->p->ntree; i++) {
    int64_t id = r->p->tree[i].id;
    if (id == DEFAULT_DECK_ID) {
      q_text(reset, 1, S("Default"));
      q_num(reset, 2, r->now);
      q_int(reset, 3, id);
      q_run(c, k, reset);
      continue;
    }
    q_int(r->grave, 1, id);
    q_int(r->grave, 2, 2);
    q_run(c, k, r->grave);
    q_int(del, 1, id);
    q_run(c, k, del);
  }
  sqlite3_stmt *count = q_prep(c, k, "SELECT count(*) AS n FROM decks NOT INDEXED");
  q_step(c, k, count);
  int64_t rows = sqlite3_column_int64(count, 0);
  q_done(count);
  for (size_t i = 0; i < r->nindex; i++) {
    str nm = r->index[i];
    sqlite3_stmt *ix = q_prep(c, k, ar_fmt(c->a, "SELECT count(*) AS n FROM decks INDEXED BY \"%.*s\" WHERE name >= ''", (int)nm.n, nm.p));
    q_step(c, k, ix);
    int64_t entries = sqlite3_column_int64(ix, 0);
    q_done(ix);
    if (entries != rows)
      cx_throw(c, NULL, 0, "deleting the deck left the decks index %.*s with %lld entries for %lld rows; nothing was changed",
               (int)nm.n, nm.p, (long long)entries, (long long)rows);
  }
}

static void remove_18(cx *c, conn *k, plan_t *p, double now) {
  sqlite3_stmt *grave = remove_rows(c, k, p);
  sqlite3_stmt *drop = q_prep(c, k, "DELETE FROM config WHERE substr(KEY, 1, ?) = ?");
  for (size_t i = 0; i < p->ntree; i++) {
    str key = str_c(ar_fmt(c->a, "_deck_%lld_", (long long)p->tree[i].id));
    q_int(drop, 1, (int64_t)key.n);
    q_text(drop, 2, key);
    q_run(c, k, drop);
  }
  sqlite3_stmt *ix = q_prep(c, k, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'decks'");
  size_t cap = 8;
  remove18_args r = {p, now, grave, ar_alloc(c->a, cap * sizeof(str)), 0};
  while (q_step(c, k, ix)) {
    if (r.nindex == cap) {
      str *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, r.index, cap * sizeof *more);
      r.index = more;
      cap *= 2;
    }
    r.index[r.nindex++] = q_col_text(c, ix, 0);
  }
  q_done(ix);
  remove_decks_18(c, k, &r);
}

static void remove_legacy(cx *c, conn *k, plan_t *p, double now) {
  sqlite3_stmt *grave = remove_rows(c, k, p);
  aj *conf = read_col_value(c, k, "conf");
  for (size_t i = 0; i < p->ntree; i++) {
    str key = str_c(ar_fmt(c->a, "_deck_%lld_", (long long)p->tree[i].id));
    size_t nk;
    str *keys = aj_keys(c->a, conf, &nk);
    for (size_t j = 0; j < nk; j++)
      if (str_starts(keys[j], key)) aj_del(conf, keys[j]);
  }
  aj *decks = p->json;
  for (size_t i = 0; i < p->ntree; i++) {
    int64_t id = p->tree[i].id;
    str key = id_key(c, (double)id);
    if (id == DEFAULT_DECK_ID) {
      aj *d = aj_get(decks, key);
      if (!d || d->type != AJ_OBJ) cx_throw(c, NULL, 0, "Cannot convert undefined or null to object");
      aj_set(c->a, d, S("name"), aj_str(c->a, S("Default")));
      aj_set(c->a, d, S("mod"), aj_num(c->a, now));
      aj_set(c->a, d, S("usn"), aj_num(c->a, -1));
      continue;
    }
    q_int(grave, 1, id);
    q_int(grave, 2, 2);
    q_run(c, k, grave);
    aj_del(decks, key);
  }
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET decks = ?, conf = ? WHERE id = 1");
  q_text(st, 1, anki_json_stringify(c->a, decks));
  q_text(st, 2, anki_json_stringify(c->a, conf));
  q_run(c, k, st);
}

void deck_remove(cx *c, conn *k, double deck_id, col_removal *out) {
  /* In the caller's one transaction (direct.c with_write), which rolls it all back on a throw. */
  plan_t p;
  if (!plan(c, k, deck_id, &p)) not_there(c, deck_id);
  double now = floor((double)now_ms() / 1000);
  return_home(c, k, &p, now);
  if (k->schema == 11) remove_legacy(c, k, &p, now);
  else remove_18(c, k, &p, now);
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, now_ms());
  q_run(c, k, st);
  out->id = p.target.id;
  out->name = p.target.name;
  int64_t decks = 0;
  for (size_t i = 0; i < p.ntree; i++)
    if (p.tree[i].id != DEFAULT_DECK_ID) decks++;
  out->decks = decks;
  out->cards = (int64_t)p.ncards;
  out->notes = (int64_t)p.nnotes;
}
