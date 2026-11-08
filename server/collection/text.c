/* The text rules notes are written with, from plusaudio/lib/deck.js (strip_html_media, Anki's
 * entity decoding, the checksum), plusaudio/lib/cardGeneration/cardText.ts (the romanisation
 * guard) and plusaudio/lib/collection/template.js (which cards a new note needs).
 *
 * The JavaScript states each rule as a regular expression; each is written out here as the
 * matcher that regular expression is, with JavaScript's meaning of \s (its whitespace set), \b
 * (ASCII word characters), /i (ASCII case only, outside unicode mode), laziness and
 * backtracking, so the text that comes out is the text that came out of Node. */
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <unicode/uscript.h>

#include "core.h"

static int word_ch(unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; }
static int lower_ascii(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
/* The literal w (lower case) at s[at], ASCII case-insensitively. */
static int ci_at(str s, size_t at, const char *w) {
  size_t n = strlen(w);
  if (s.n - at < n || at > s.n) return 0;
  for (size_t i = 0; i < n; i++)
    if (lower_ascii((unsigned char)s.p[at + i]) != w[i]) return 0;
  return 1;
}
/* JavaScript's \s at s[at]: its length in bytes, or 0. */
static size_t space_at(str s, size_t at) {
  if (at >= s.n) return 0;
  size_t next = at;
  uint32_t cp = utf8_next(s, &next);
  return js_space(cp) ? next - at : 0;
}
static size_t skip_spaces(str s, size_t at) {
  size_t k;
  while ((k = space_at(s, at))) at += k;
  return at;
}
static long next_gt(str s, size_t from) {
  for (size_t i = from; i < s.n; i++)
    if (s.p[i] == '>') return (long)i;
  return -1;
}

/* /<\s*(?:img|audio|object)\b[^>]*?\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))[^>]*>/gi
 * at s[i] (a '<'): the end of the match and the captured value, or 0. */
static size_t media_tag_at(str s, size_t i, str *value) {
  size_t at = skip_spaces(s, i + 1);
  const char *tags[] = {"img", "audio", "object"};
  size_t after = 0;
  for (int t = 0; t < 3; t++)
    if (ci_at(s, at, tags[t])) {
      size_t e = at + strlen(tags[t]);
      if (e < s.n && word_ch((unsigned char)s.p[e])) continue; /* \b */
      after = e;
      break;
    }
  if (!after) return 0;
  /* [^>]*? lazily: each position k up to the first '>', the rest tried at each. */
  for (size_t k = after; k < s.n && s.p[k] != '>'; k++) {
    if (word_ch((unsigned char)s.p[k - 1])) continue; /* \b before src|data: the one before is not a word character */
    size_t m;
    if (ci_at(s, k, "src")) m = k + 3;
    else if (ci_at(s, k, "data")) m = k + 4;
    else continue;
    m = skip_spaces(s, m);
    if (m >= s.n || s.p[m] != '=') continue;
    size_t q = skip_spaces(s, m + 1);
    /* "..." then [^>]*> */
    if (q < s.n && s.p[q] == '"') {
      const char *close = memchr(s.p + q + 1, '"', s.n - q - 1);
      if (close) {
        size_t v = (size_t)(close - s.p) + 1;
        long gt = next_gt(s, v);
        if (gt >= 0) {
          *value = str_sub(s, q + 1, v - 1);
          return (size_t)gt + 1;
        }
      }
    }
    if (q < s.n && s.p[q] == '\'') {
      const char *close = memchr(s.p + q + 1, '\'', s.n - q - 1);
      if (close) {
        size_t v = (size_t)(close - s.p) + 1;
        long gt = next_gt(s, v);
        if (gt >= 0) {
          *value = str_sub(s, q + 1, v - 1);
          return (size_t)gt + 1;
        }
      }
    }
    /* [^\s>]* greedily; a shorter run never helps, as the end needs a '>' at or after it. */
    size_t v = q;
    while (v < s.n && s.p[v] != '>' && !space_at(s, v)) {
      size_t nx = v;
      utf8_next(s, &nx);
      v = nx;
    }
    long gt = next_gt(s, v);
    if (gt >= 0) {
      *value = str_sub(s, q, v);
      return (size_t)gt + 1;
    }
  }
  return 0;
}

/* deck.js decodeEntities: /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, then every U+00A0 as a space.
 * A surrogate an entity names stays a UTF-16 unit until the next one, so &#xD83D;&#xDE00; makes the
 * pair it makes in JavaScript; a lone one is written as U+FFFD, as Node writes a lone one. */
typedef struct { buf *b; uint32_t high; } emit16;
static void flush_high(emit16 *e) {
  if (e->high) utf8_put(e->b, 0xfffd);
  e->high = 0;
}
static void emit_cp(emit16 *e, uint32_t cp) {
  if (cp >= 0xdc00 && cp <= 0xdfff && e->high) {
    uint32_t full = 0x10000 + ((e->high - 0xd800) << 10) + (cp - 0xdc00);
    e->high = 0;
    utf8_put(e->b, full);
    return;
  }
  flush_high(e);
  if (cp >= 0xd800 && cp <= 0xdbff) {
    e->high = cp;
    return;
  }
  utf8_put(e->b, cp == 0xa0 ? 0x20 : cp);
}
static void emit_bytes(emit16 *e, str s) {
  for (size_t at = 0; at < s.n;) emit_cp(e, utf8_next(s, &at));
}

static int hexd(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static int alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

static str decode_entities(cx *c, str s) {
  buf b = {0};
  emit16 e = {&b, 0};
  size_t i = 0, plain = 0;
  while (i < s.n) {
    if (s.p[i] != '&') {
      i++;
      continue;
    }
    size_t body = i + 1, end = 0;
    if (body < s.n && s.p[body] == '#') {
      /* #x? greedily: with the x first, then without. */
      size_t starts[2] = {body + 1, body + 1};
      int tries = 1;
      if (body + 1 < s.n && s.p[body + 1] == 'x') starts[0] = body + 2, tries = 2;
      for (int t = 0; t < tries && !end; t++) {
        size_t k = starts[t];
        while (k < s.n && hexd(s.p[k])) k++;
        if (k > starts[t] && k < s.n && s.p[k] == ';') end = k;
      }
    } else {
      size_t k = body;
      while (k < s.n && alpha(s.p[k])) k++;
      if (k > body && k < s.n && s.p[k] == ';') end = k;
    }
    if (!end) {
      i++;
      continue;
    }
    str whole = str_sub(s, i, end + 1), name = str_sub(s, body, end);
    int replaced = 0;
    uint32_t cp = 0;
    if (name.p[0] == '#') {
      int hex = name.n > 1 && (name.p[1] == 'x' || name.p[1] == 'X');
      str digits = str_sub(name, hex ? 2 : 1, name.n);
      /* Number.parseInt: the leading digits of the radix; none is NaN. */
      double v = 0;
      size_t nd = 0;
      if (hex) {
        while (nd < digits.n && hexd(digits.p[nd])) {
          char ch = digits.p[nd];
          v = v * 16 + (ch <= '9' ? ch - '0' : lower_ascii(ch) - 'a' + 10);
          nd++;
        }
      } else {
        while (nd < digits.n && digits.p[nd] >= '0' && digits.p[nd] <= '9') nd++;
        v = nd ? strtod(str_z(c->a, str_sub(digits, 0, nd)), NULL) : NAN;
      }
      if (hex && !nd) v = NAN;
      if (isfinite(v) && v > 0) {
        if (v > 0x10ffff) {
          buf m = {0};
          js_num(&m, v);
          str msg = buf_str(c->a, &m);
          buf_free(&m);
          buf_free(&b);
          cx_throw(c, NULL, 0, "Invalid code point %.*s", (int)msg.n, msg.p);
        }
        cp = (uint32_t)v;
        replaced = 1;
      }
    } else {
      str low = js_lower(c->a, name);
      const char *names[] = {"amp", "lt", "gt", "quot", "apos", "nbsp"};
      const uint32_t cps[] = {'&', '<', '>', '"', '\'', 0xa0};
      for (int k = 0; k < 6; k++)
        if (str_eq_c(low, names[k])) cp = cps[k], replaced = 1;
    }
    emit_bytes(&e, str_sub(s, plain, i));
    if (replaced) emit_cp(&e, cp);
    else emit_bytes(&e, whole);
    i = end + 1;
    plain = i;
  }
  emit_bytes(&e, str_sub(s, plain, s.n));
  flush_high(&e);
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

str strip_html_preserving_media(cx *c, str html) {
  /* 1. A media tag becomes " <its src> ". */
  buf b = {0};
  size_t i = 0, plain = 0;
  while (i < html.n) {
    str value;
    size_t end;
    if (html.p[i] == '<' && (end = media_tag_at(html, i, &value))) {
      buf_s(&b, str_sub(html, plain, i));
      buf_ch(&b, ' ');
      buf_s(&b, value);
      buf_ch(&b, ' ');
      i = plain = end;
    } else {
      i++;
    }
  }
  buf_s(&b, str_sub(html, plain, html.n));
  str s1 = buf_str(c->a, &b);
  buf_free(&b);
  /* 2. /<!--.*?-->/gs */
  buf b2 = {0};
  for (i = 0, plain = 0; i + 3 < s1.n;) {
    if (!memcmp(s1.p + i, "<!--", 4)) {
      const char *close = NULL;
      for (size_t k = i + 4; k + 2 < s1.n; k++)
        if (!memcmp(s1.p + k, "-->", 3)) {
          close = s1.p + k;
          break;
        }
      if (close) {
        buf_s(&b2, str_sub(s1, plain, i));
        i = plain = (size_t)(close - s1.p) + 3;
        continue;
      }
    }
    i++;
  }
  buf_s(&b2, str_sub(s1, plain, s1.n));
  str s2 = buf_str(c->a, &b2);
  buf_free(&b2);
  /* 3. /<[^>]*>/g */
  buf b3 = {0};
  for (i = 0, plain = 0; i < s2.n;) {
    if (s2.p[i] == '<') {
      long gt = next_gt(s2, i + 1);
      if (gt >= 0) {
        buf_s(&b3, str_sub(s2, plain, i));
        i = plain = (size_t)gt + 1;
        continue;
      }
    }
    i++;
  }
  buf_s(&b3, str_sub(s2, plain, s2.n));
  str s3 = buf_str(c->a, &b3);
  buf_free(&b3);
  return decode_entities(c, s3);
}

/* fieldChecksum: the first 8 hex digits of the sha1 of the text it is given, as a number. The
 * caller strips the first field once (strip_html_preserving_media) and hands the result here, as
 * Anki's own add_note does; plusaudio/lib/deck.js stripped a second time inside, which decoded an
 * entity twice and gave a checksum Anki disagrees with (the PR #30 review, finding 2). */
int64_t field_checksum(cx *c, str stripped) {
  (void)c;
  char hex[41];
  sha1_hex(stripped.p, stripped.n, hex);
  hex[8] = 0;
  return (int64_t)strtoull(hex, NULL, 16);
}

str *anki_fields(cx *c, const str *fields, size_t n) {
  str *out = ar_alloc(c->a, (n + 1) * sizeof *out);
  for (size_t i = 0; i < n; i++) {
    buf b = {0};
    str f = fields[i];
    for (size_t at = 0; at < f.n; at++) {
      unsigned char ch = (unsigned char)f.p[at];
      if ((ch < 0x20 && ch != 0x09 && ch != 0x0a) || ch == 0x7f) continue;
      buf_ch(&b, (char)ch);
    }
    out[i] = js_nfc(c->a, buf_str(c->a, &b));
    buf_free(&b);
  }
  return out;
}

str join_fields(cx *c, const str *fields, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (memchr(fields[i].p, '\x1f', fields[i].n))
      cx_throw(c, NULL, 0, "field %zu holds Anki's field separator (0x1f); pass the fields through ankiFields first", i);
  buf b = {0};
  for (size_t i = 0; i < n; i++) {
    if (i) buf_ch(&b, '\x1f');
    buf_s(&b, fields[i]);
  }
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

str *split_fields(cx *c, str flds, size_t *n) {
  size_t count = 1;
  for (size_t i = 0; i < flds.n; i++)
    if (flds.p[i] == '\x1f') count++;
  str *out = ar_alloc(c->a, count * sizeof *out);
  size_t k = 0, start = 0;
  for (size_t i = 0; i <= flds.n; i++)
    if (i == flds.n || flds.p[i] == '\x1f') {
      out[k++] = str_sub(flds, start, i);
      start = i + 1;
    }
  *n = k;
  return out;
}

str render_audio_reference(cx *c, str filename) {
  buf b = {0};
  buf_c(&b, "<audio src=\"");
  for (size_t i = 0; i < filename.n; i++) {
    if (filename.p[i] == '&') buf_c(&b, "&amp;");
    else if (filename.p[i] == '"') buf_c(&b, "&quot;");
    else buf_ch(&b, filename.p[i]);
  }
  buf_c(&b, "\"></audio>");
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* ---- cardText.ts: the romanisation guard ---- */
typedef struct { const char *code; UScriptCode scripts[3]; int n; } native_script;
static const native_script NATIVE[] = {
  {"ko", {USCRIPT_HANGUL}, 1}, {"ja", {USCRIPT_HIRAGANA, USCRIPT_KATAKANA, USCRIPT_HAN}, 3}, {"zh_cn", {USCRIPT_HAN}, 1},
  {"zh_hk", {USCRIPT_HAN}, 1}, {"ru", {USCRIPT_CYRILLIC}, 1}, {"ar", {USCRIPT_ARABIC}, 1}, {"ur", {USCRIPT_ARABIC}, 1},
  {"hi", {USCRIPT_DEVANAGARI}, 1}, {"th", {USCRIPT_THAI}, 1},
};

/* normalizeLanguageCode: lower case, '-' as '_', trimmed. */
static const native_script *native_for(cx *c, str language) {
  str low = js_lower(c->a, language);
  char *p = ar_dup(c->a, low.p, low.n);
  for (size_t i = 0; i < low.n; i++)
    if (p[i] == '-') p[i] = '_';
  str code = js_trim((str){p, low.n});
  for (size_t i = 0; i < sizeof NATIVE / sizeof *NATIVE; i++)
    if (str_eq_c(code, NATIVE[i].code)) return &NATIVE[i];
  return NULL;
}

int looks_romanized(cx *c, str text, str language) {
  const native_script *ns = native_for(c, language);
  if (!ns) return 0;
  str trimmed = js_trim(text);
  if (!trimmed.n) return 0;
  for (size_t at = 0; at < trimmed.n;) {
    UChar32 cp = (UChar32)utf8_next(trimmed, &at);
    UErrorCode e = U_ZERO_ERROR;
    UScriptCode sc = uscript_getScript(cp, &e);
    for (int k = 0; k < ns->n; k++)
      if (sc == ns->scripts[k]) return 0;
  }
  for (size_t i = 0; i < trimmed.n; i++)
    if (alpha(trimmed.p[i])) return 1;
  return 0;
}

/* ---- template.js ---- */
enum { T_TEXT, T_REPL, T_OPEN, T_OPEN_NEG, T_CLOSE };
typedef struct { int type; str key; } token;
typedef struct node node;
struct node { int type; str key; node *children; size_t nchildren; };

/* /\{\{([^{}]*)\}\}/, leftmost: the body's bounds, or 0. */
static int open_tag(str s, size_t from, size_t *start, size_t *body0, size_t *body1, size_t *end) {
  for (size_t i = from; i + 1 < s.n; i++) {
    if (s.p[i] != '{' || s.p[i + 1] != '{') continue;
    size_t j = i + 2;
    while (j < s.n && s.p[j] != '{' && s.p[j] != '}') j++;
    if (j + 1 < s.n && s.p[j] == '}' && s.p[j + 1] == '}') {
      *start = i, *body0 = i + 2, *body1 = j, *end = j + 2;
      return 1;
    }
  }
  return 0;
}

static token *tokenize(cx *c, str t, size_t *n) {
  size_t cap = 16, k = 0;
  token *out = ar_alloc(c->a, cap * sizeof *out);
  size_t at = 0;
  for (;;) {
    if (k + 2 >= cap) {
      token *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, out, k * sizeof *out);
      out = more;
      cap *= 2;
    }
    size_t start, b0, b1, end;
    if (!open_tag(t, at, &start, &b0, &b1, &end)) {
      if (at < t.n) out[k++] = (token){T_TEXT, {0}};
      break;
    }
    if (start > at) out[k++] = (token){T_TEXT, {0}};
    str body = js_trim(str_sub(t, b0, b1));
    if (body.n && body.p[0] == '#') out[k++] = (token){T_OPEN, js_trim(str_sub(body, 1, body.n))};
    else if (body.n && body.p[0] == '^') out[k++] = (token){T_OPEN_NEG, js_trim(str_sub(body, 1, body.n))};
    else if (body.n && body.p[0] == '/') out[k++] = (token){T_CLOSE, js_trim(str_sub(body, 1, body.n))};
    else {
      size_t last = 0;
      for (size_t i = 0; i < body.n; i++)
        if (body.p[i] == ':') last = i + 1;
      out[k++] = (token){T_REPL, js_trim(str_sub(body, last, body.n))};
    }
    at = end;
  }
  *n = k;
  return out;
}

/* parse; -1 on a template that does not parse (the caller reads that as "renders nothing"). */
static int parse_until(cx *c, const token *t, size_t n, size_t *cursor, int open, node **out, size_t *nout) {
  size_t cap = 8, k = 0;
  node *nodes = ar_alloc(c->a, cap * sizeof *nodes);
  while (*cursor < n) {
    const token *tk = &t[*cursor];
    if (tk->type == T_CLOSE) {
      if (!open) return -1;
      (*cursor)++;
      *out = nodes, *nout = k;
      return 0;
    }
    (*cursor)++;
    if (k == cap) {
      node *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, nodes, k * sizeof *nodes);
      nodes = more;
      cap *= 2;
    }
    node *nd = &nodes[k++];
    nd->type = tk->type;
    nd->key = tk->key;
    if (tk->type == T_OPEN || tk->type == T_OPEN_NEG)
      if (parse_until(c, t, n, cursor, 1, &nd->children, &nd->nchildren) < 0) return -1;
  }
  if (open) return -1;
  *out = nodes, *nout = k;
  return 0;
}

typedef struct { const str *names; size_t n; } nameset;
static int has_name(const nameset *s, str key) {
  for (size_t i = 0; i < s->n; i++)
    if (str_eq(s->names[i], key)) return 1;
  return 0;
}

static int renders(const nameset *nonempty, const node *nodes, size_t n) {
  for (size_t i = 0; i < n; i++) {
    const node *nd = &nodes[i];
    if (nd->type == T_TEXT) continue;
    if (nd->type == T_REPL) {
      if (has_name(nonempty, nd->key)) return 1;
    } else if (nd->type == T_OPEN) {
      if (has_name(nonempty, nd->key) && renders(nonempty, nd->children, nd->nchildren)) return 1;
    } else if (nd->type == T_OPEN_NEG) {
      if (has_name(nonempty, nd->key)) continue;
      if (renders(nonempty, nd->children, nd->nchildren)) return 1;
    }
  }
  return 0;
}

int template_renders_nonempty(cx *c, str question, const str *names, size_t n) {
  nameset s = {names, n};
  size_t nt, cursor = 0, nn;
  token *t = tokenize(c, question, &nt);
  node *nodes;
  if (parse_until(c, t, nt, &cursor, 0, &nodes, &nn) < 0) return 0;
  return renders(&s, nodes, nn);
}

static int template_renders(cx *c, str question, const nameset *nonempty) {
  size_t nt, cursor = 0, nn;
  token *t = tokenize(c, question, &nt);
  node *nodes;
  if (parse_until(c, t, nt, &cursor, 0, &nodes, &nn) < 0) return 0;
  return renders(nonempty, nodes, nn);
}

static int cmp_i64(const void *x, const void *y) {
  int64_t a = *(const int64_t *)x, b = *(const int64_t *)y;
  return a < b ? -1 : a > b;
}

size_t ordinals_for_new_note(cx *c, const col_notetype *nt, const str *fields, size_t nfields, size_t ntags, int64_t **out) {
  if (nt->cloze) {
    /* /\{\{c(\d+)::/g in every field; each number above 0, capped at 500, once. */
    size_t cap = 8, k = 0;
    int64_t *nums = ar_alloc(c->a, cap * sizeof *nums);
    for (size_t f = 0; f < nfields; f++) {
      str v = fields[f];
      for (size_t i = 0; i + 3 < v.n; i++) {
        if (v.p[i] != '{' || v.p[i + 1] != '{' || v.p[i + 2] != 'c') continue;
        size_t j = i + 3;
        while (j < v.n && v.p[j] >= '0' && v.p[j] <= '9') j++;
        if (j == i + 3 || j + 1 >= v.n || v.p[j] != ':' || v.p[j + 1] != ':') continue;
        double num = strtod(str_z(c->a, str_sub(v, i + 3, j)), NULL);
        if (num > 0) {
          int64_t capped = num > 500 ? 500 : (int64_t)num;
          int seen = 0;
          for (size_t q = 0; q < k; q++)
            if (nums[q] == capped) seen = 1;
          if (!seen) {
            if (k == cap) {
              int64_t *more = ar_alloc(c->a, cap * 2 * sizeof *more);
              memcpy(more, nums, k * sizeof *nums);
              nums = more;
              cap *= 2;
            }
            nums[k++] = capped;
          }
        }
        i = j + 1;
      }
    }
    qsort(nums, k, sizeof *nums, cmp_i64);
    for (size_t q = 0; q < k; q++) nums[q] -= 1;
    if (!k) nums[k++] = 0;
    *out = nums;
    return k;
  }
  /* nonemptyFieldsFor: the note's non-empty fields, the always-present specials it does not shadow,
   * and Tags when the note has some. */
  static const char *SPECIAL[] = {"Card", "CardFlag", "Deck", "Subdeck", "Type", "CardID"};
  str *names = ar_alloc(c->a, (nt->nfields + 8) * sizeof *names);
  size_t nn = 0;
  for (size_t i = 0; i < nt->nfields; i++)
    if (i < nfields && fields[i].n > 0) names[nn++] = nt->fields[i];
  nameset own = {nt->fields, nt->nfields};
  for (int s = 0; s < 6; s++)
    if (!has_name(&own, str_c(SPECIAL[s]))) names[nn++] = str_c(SPECIAL[s]);
  if (!has_name(&own, S("Tags")) && ntags > 0) names[nn++] = S("Tags");
  nameset nonempty = {names, nn};
  int64_t *ords = ar_alloc(c->a, (nt->ntemplates + 1) * sizeof *ords);
  size_t k = 0;
  for (size_t t = 0; t < nt->ntemplates; t++)
    if (template_renders(c, nt->templates[t].question, &nonempty)) ords[k++] = (int64_t)t;
  if (!k) ords[k++] = 0;
  *out = ords;
  return k;
}
