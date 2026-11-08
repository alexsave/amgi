/* The free starter deck: the port of what were src/server/anki/starterDeck.js and starterPhrases.js. starterDeck.js's
 * header says what it is: ten parallel phrases in every language amgi supports
 * (src/data/starterPhrases.tsv) with clips that ship in anki/starter/media, named as amgi's own
 * generator would name them (audio-store.js starterClipName), written as ordinary notes on the
 * ordinary amgi note type. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "amgi.h"
#include "messages.h"

typedef struct {
  str *codes;
  size_t ncodes;
  str **phrases; /* phrases[c][i] */
  size_t nphrases;
} table;

static int read_file(arena *a, const char *path, str *out) {
  FILE *f = fopen(path, "rb");
  if (!f) return -1;
  buf b = {0};
  char chunk[1 << 14];
  size_t r;
  while ((r = fread(chunk, 1, sizeof chunk, f)) > 0) buf_put(&b, chunk, r);
  fclose(f);
  *out = buf_str(a, &b);
  buf_free(&b);
  return 0;
}

static str *split_on(arena *a, str s, char sep, size_t *n) {
  size_t count = 1;
  for (size_t i = 0; i < s.n; i++) count += s.p[i] == sep;
  str *out = ar_alloc(a, count * sizeof *out);
  *n = 0;
  size_t at = 0;
  for (size_t i = 0; i <= s.n; i++)
    if (i == s.n || s.p[i] == sep) out[(*n)++] = str_sub(s, at, i), at = i + 1;
  return out;
}

/* parseStarterPhrases, or 0 when the text is not a whole table. */
static int parse_phrases(arena *a, str text, table *t) {
  size_t nl;
  str *lines = split_on(a, utf8_clean(a, text), '\n', &nl);
  if (nl && lines[nl - 1].n == 0) nl--;
  if (nl < 2) return 0;
  t->codes = split_on(a, lines[0], '\t', &t->ncodes);
  for (size_t i = 0; i < t->ncodes; i++) {
    if (!t->codes[i].n) return 0;
    for (size_t j = 0; j < i; j++)
      if (str_eq(t->codes[i], t->codes[j])) return 0;
  }
  t->nphrases = nl - 1;
  t->phrases = ar_alloc(a, t->ncodes * sizeof *t->phrases);
  for (size_t c = 0; c < t->ncodes; c++) t->phrases[c] = ar_alloc(a, t->nphrases * sizeof(str));
  for (size_t l = 1; l < nl; l++) {
    size_t nc;
    str *cells = split_on(a, lines[l], '\t', &nc);
    if (nc != t->ncodes) return 0;
    for (size_t c = 0; c < nc; c++) {
      if (!cells[c].n) return 0;
      t->phrases[c][l - 1] = cells[c];
    }
  }
  return 1;
}

static int read_table(arena *a, table *t) {
  str text;
  const char *path = str_z(a, path_join(a, amgi_root(a), S("src/data/starterPhrases.tsv")));
  return read_file(a, path, &text) == 0 && parse_phrases(a, text, t);
}

static const str *phrases_of(const table *t, str code) {
  for (size_t c = 0; c < t->ncodes; c++)
    if (str_eq(t->codes[c], code)) return t->phrases[c];
  return NULL;
}

/* The shipped clip's name for text, or empty when this build has none. */
static str shipped_clip(arena *a, str text, str language) {
  str name = amgi_media_name(a, text, language, "mp3");
  str path = path_join(a, path_join(a, amgi_root(a), S("anki/starter/media")), name);
  struct stat sb;
  return stat(str_z(a, path), &sb) == 0 ? name : S("");
}

static int by_js(const void *x, const void *y) { return js_cmp(*(const str *)x, *(const str *)y); }

void amgi_starter_get(arena *a, cb_http_res *res) {
  table t = {0};
  int have = read_table(a, &t);
  str *langs = ar_alloc(a, (t.ncodes + 1) * sizeof(str));
  size_t nl = 0;
  for (size_t c = 0; have && c < t.ncodes; c++) {
    int all = t.nphrases > 0;
    for (size_t i = 0; all && i < t.nphrases; i++) all = shipped_clip(a, t.phrases[c][i], t.codes[c]).n > 0;
    if (all) langs[nl++] = t.codes[c];
  }
  if (nl) qsort(langs, nl, sizeof(str), by_js);
  int gen = amgi_generation_available();
  wire_strs ws = {ar_alloc(a, (nl + 1) * sizeof(wire_str)), (uint32_t)nl};
  for (size_t i = 0; i < nl; i++) ws.v[i] = amgi_ws(langs[i]);
  wire_starter_state w = {(uint8_t)(!gen && nl > 1), (uint8_t)gen, ws, have ? (uint32_t)t.nphrases : 0};
  amgi_send_wire(a, res, 200, WK_STARTER_STATE, &w);
}

amgi_fields amgi_field_indexes(arena *a, const col_notetype *nt) {
  const char *names[] = {"cue", "cueaudio", "target", "targetaudio", "language", "notes"};
  int at[6];
  for (int k = 0; k < 6; k++) {
    at[k] = -1;
    for (size_t i = 0; nt && i < nt->nfields && at[k] < 0; i++)
      if (str_eq_c(js_lower(a, nt->fields[i]), names[k])) at[k] = (int)i;
  }
  return (amgi_fields){at[0], at[1], at[2], at[3], at[4], at[5]};
}

/* What lyricsParse.js's normalizeForDedupe was: trimmed, runs of blanks as one space, trailing punctuation off
 * (unless that leaves nothing). */
static int trailing_punct(uint32_t cp) {
  static const uint32_t SET[] = {',', '.', '!', '?', ';', ':', 0x3001, 0x3002, 0xff01, 0xff1f, 0xff0c, 0xff1b, 0xff1a,
                                 0x2026, '"', '\'', 0x201c, 0x201d, 0x2018, 0x2019};
  if (js_space(cp)) return 1;
  for (size_t i = 0; i < sizeof SET / sizeof *SET; i++)
    if (SET[i] == cp) return 1;
  return 0;
}
static str normalize_for_dedupe(arena *a, str line) {
  str t = js_trim(line);
  buf b = {0};
  int in_space = 0;
  for (size_t at = 0; at < t.n;) {
    size_t from = at;
    uint32_t cp = utf8_next(t, &at);
    if (js_space(cp)) {
      if (!in_space) buf_ch(&b, ' ');
      in_space = 1;
    } else {
      buf_put(&b, t.p + from, at - from);
      in_space = 0;
    }
  }
  str trimmed = buf_str(a, &b);
  buf_free(&b);
  /* up to the end of the last character that is not trailing punctuation */
  size_t cut = 0, at = 0;
  while (at < trimmed.n) {
    uint32_t cp = utf8_next(trimmed, &at);
    if (!trailing_punct(cp)) cut = at;
  }
  str stripped = str_sub(trimmed, 0, cut);
  return stripped.n ? stripped : trimmed;
}

/* attachClip: the reference a field holds, or "" when this build has no such clip. -1 on an error. */
static int attach_clip(arena *a, const amgi_ops *o, str text, str language, str *ref, col_err *e) {
  str name = shipped_clip(a, text, language);
  *ref = S("");
  if (!name.n) return 0;
  int has;
  if (ops_has_media(a, o, name, &has, e)) return -1;
  if (has) {
    *ref = amgi_audio_reference(a, name);
    return 0;
  }
  str data, stored;
  const char *path = str_z(a, path_join(a, path_join(a, amgi_root(a), S("anki/starter/media")), name));
  if (read_file(a, path, &data) != 0) {
    e->message = str_c(ar_fmt(a, "ENOENT: no such file or directory, open '%s'", path));
    return -1;
  }
  if (ops_add_media(a, o, name, data.p, data.n, &stored, e)) return -1;
  *ref = amgi_audio_reference(a, stored);
  return 0;
}

int amgi_starter_build(arena *a, const amgi_ops *o, str known, str learning, str deck_name, amgi_starter_built *out,
                       str *message) {
  table t = {0};
  if (!read_table(a, &t)) return *message = S("This copy of amgi has no starter phrases in it."), -1;
  if (str_eq(known, learning)) return *message = S("Pick two different languages."), -1;
  const str *cues = phrases_of(&t, known), *targets = phrases_of(&t, learning);
  if (!cues || !targets) return *message = S("amgi has no starter phrases for that pair of languages."), -1;
  col_notetype *nts;
  size_t n;
  col_err e = {0};
  if (ops_list_notetypes(a, o, &nts, &n, &e)) return *message = e.message, -1;
  const col_notetype *nt = NULL;
  for (size_t i = 0; i < n && !nt; i++)
    if (str_eq_c(nts[i].name, AMGI_NOTETYPE_NAME)) nt = &nts[i];
  if (!nt) return *message = S("Restart Anki once so it adds the \"" AMGI_NOTETYPE_NAME "\" card type, then try again."), -1;
  amgi_fields idx = amgi_field_indexes(a, nt);
  col_deck_made deck;
  if (ops_create_deck(a, o, deck_name, &deck, &e)) return *message = e.message, -1;

  str *already = NULL;
  size_t nalready = 0;
  if (idx.target >= 0) {
    str *values;
    size_t nv;
    col_err swallowed = {0};
    if (!ops_field_values(a, o, (double)deck.id, (double)nt->id, idx.target, &values, &nv, &swallowed)) {
      already = ar_alloc(a, (nv + 1) * sizeof(str));
      for (size_t i = 0; i < nv; i++) already[nalready++] = normalize_for_dedupe(a, values[i]);
    }
  }
  uint32_t added = 0, duplicates = 0;
  for (size_t i = 0; i < t.nphrases; i++) {
    str key = normalize_for_dedupe(a, targets[i]);
    int dup = 0;
    for (size_t k = 0; k < nalready && !dup; k++) dup = str_eq(already[k], key);
    if (dup) {
      duplicates++;
      continue;
    }
    str *fields = ar_alloc(a, (nt->nfields + 1) * sizeof(str));
    for (size_t f = 0; f < nt->nfields; f++) fields[f] = S("");
    if (idx.cue >= 0) fields[idx.cue] = cues[i];
    if (idx.target >= 0) fields[idx.target] = targets[i];
    if (idx.language >= 0) fields[idx.language] = learning;
    str cue_clip, target_clip;
    if (attach_clip(a, o, cues[i], known, &cue_clip, &e)) return *message = e.message, -1;
    if (attach_clip(a, o, targets[i], learning, &target_clip, &e)) return *message = e.message, -1;
    if (idx.cue_audio >= 0 && cue_clip.n) fields[idx.cue_audio] = cue_clip;
    if (idx.target_audio >= 0 && target_clip.n) fields[idx.target_audio] = target_clip;
    static const str TAG = {"amgi-starter", 12};
    col_new_note note = {(double)deck.id, (double)nt->id, fields, nt->nfields, (str *)&TAG, 1, 1, learning, idx.target >= 0,
                         idx.target};
    col_added r;
    if (ops_add_note(a, o, &note, &r, &e)) return *message = e.message, -1;
    added++;
  }
  *out = (amgi_starter_built){deck.id, deck_name, added, duplicates};
  return 0;
}
