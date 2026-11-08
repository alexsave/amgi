/* Text work the React app did with JS strings and regexes, on UTF-8 bytes: each function names the
 * JS it stands for, and ui/test/text.test.mjs runs both on the same inputs. */
#include "app.h"

uint32_t zlen(const char *s) {
  uint32_t n = 0;
  while (s[n]) n++;
  return n;
}
int same(const char *a, uint32_t alen, const char *b, uint32_t blen) {
  if (alen != blen) return 0;
  for (uint32_t i = 0; i < alen; i++)
    if (a[i] != b[i]) return 0;
  return 1;
}
int same_z(const char *a, uint32_t alen, const char *z) { return same(a, alen, z, zlen(z)); }
static char lower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c + 32) : c; }
int same_ascii_nocase(const char *a, uint32_t alen, const char *z) {
  uint32_t n = zlen(z);
  if (alen != n) return 0;
  for (uint32_t i = 0; i < n; i++)
    if (lower(a[i]) != lower(z[i])) return 0;
  return 1;
}

void text_set(text *t, const char *p, uint32_t len) {
  char *q = cd_alloc(len + 1);
  if (len) __builtin_memcpy(q, p, len);
  q[len] = 0;
  cd_free(t->p);
  t->p = q;
  t->len = len;
}
void text_setz(text *t, const char *z) { text_set(t, z, zlen(z)); }
void text_free(text *t) {
  cd_free(t->p);
  t->p = 0;
  t->len = 0;
}

uint32_t id_dec(char *dst, int64_t id) {
  char digits[20];
  uint32_t k = 0, n = 0;
  if (id < 0) id = 0;
  do digits[k++] = (char)('0' + id % 10); while ((id /= 10) > 0);
  while (k) dst[n++] = digits[--k];
  return n;
}
int64_t dec_id(const char *s, uint32_t len) {
  int64_t id = 0;
  if (!len || len > 18) return -1;
  for (uint32_t i = 0; i < len; i++) {
    if (s[i] < '0' || s[i] > '9') return -1;
    id = id * 10 + (s[i] - '0');
  }
  return id;
}

/* The code point at s[i] (UTF-8), and its length in *n; a stray byte reads as itself, length 1. */
static uint32_t cp_at(const char *s, uint32_t len, uint32_t i, uint32_t *n) {
  uint8_t c = (uint8_t)s[i];
  uint32_t need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
  if (need == 1 || i + need > len) return *n = 1, c;
  uint32_t cp = c & (0x7f >> need);
  for (uint32_t k = 1; k < need; k++) cp = cp << 6 | ((uint8_t)s[i + k] & 0x3f);
  *n = need;
  return cp;
}
/* The start of the code point that ends at s[end - 1]. */
static uint32_t cp_start(const char *s, uint32_t end) {
  uint32_t i = end - 1;
  while (i > 0 && ((uint8_t)s[i] & 0xc0) == 0x80 && end - i < 4) i--;
  return i;
}
/* JS's \s: WhiteSpace and LineTerminator. */
static int is_space(uint32_t c) {
  return (c >= 9 && c <= 13) || c == 0x20 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 ||
         c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
wire_str trim(wire_str s) {
  uint32_t a = 0, b = s.len, n;
  while (a < b && is_space(cp_at(s.p, s.len, a, &n))) a += n;
  while (b > a) {
    uint32_t i = cp_start(s.p, b);
    if (!is_space(cp_at(s.p, s.len, i, &n)) || i + n != b) break;
    b = i;
  }
  return (wire_str){s.p + a, b - a};
}
/* Runs of \s as one space, in place over dst (n bytes); returns the new length. */
static uint32_t collapse(char *dst, uint32_t n) {
  uint32_t w = 0, cl;
  int in_space = 0;
  for (uint32_t i = 0; i < n; i += cl) {
    uint32_t c = cp_at(dst, n, i, &cl);
    if (is_space(c)) {
      if (!in_space) dst[w++] = ' ';
      in_space = 1;
    } else {
      for (uint32_t k = 0; k < cl; k++) dst[w++] = dst[i + k];
      in_space = 0;
    }
  }
  return w;
}
static uint32_t trim_in_place(char *dst, uint32_t n) {
  wire_str t = trim((wire_str){dst, n});
  if (t.p != dst && t.len) __builtin_memmove(dst, t.p, t.len);
  return t.len;
}
/* Every <...> (a < with a > after it) as rep (0: nothing), into dst. */
static uint32_t untag(char *dst, wire_str s, char rep) {
  uint32_t w = 0;
  for (uint32_t i = 0; i < s.len; i++) {
    if (s.p[i] == '<') {
      uint32_t k = i + 1;
      while (k < s.len && s.p[k] != '>') k++;
      if (k < s.len) {
        if (rep) dst[w++] = rep;
        i = k;
        continue;
      }
    }
    dst[w++] = s.p[i];
  }
  return w;
}
uint32_t strip_html(char *dst, wire_str s) {
  uint32_t n = untag(dst, s, ' '), w = 0;
  static const char NBSP[] = "&nbsp;";
  for (uint32_t i = 0; i < n; i++) {
    if (n - i >= 6 && same(dst + i, 6, NBSP, 6)) {
      dst[w++] = ' ';
      i += 5;
    } else {
      dst[w++] = dst[i];
    }
  }
  return trim_in_place(dst, collapse(dst, w));
}
uint32_t strip_tags(char *dst, wire_str s) { return trim_in_place(dst, untag(dst, s, 0)); }

static int starts_nocase(const char *s, uint32_t len, const char *z) {
  uint32_t n = zlen(z);
  if (len < n) return 0;
  for (uint32_t i = 0; i < n; i++)
    if (lower(s[i]) != z[i]) return 0;
  return 1;
}
static int ascii_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
/* /<audio[^>]*\ssrc\s*=\s*["']([^"']+)["']/i: the tag's last \ssrc= with a quoted value (the
 * greedy [^>]* backs off from the tag's end), at the first <audio that has one. */
wire_str audio_src(wire_str f) {
  for (uint32_t i = 0; i + 6 <= f.len; i++) {
    if (!starts_nocase(f.p + i, f.len - i, "<audio")) continue;
    uint32_t end = i + 6;
    while (end < f.len && f.p[end] != '>') end++;
    for (uint32_t k = end; k-- > i + 6;) {
      if (!ascii_space(f.p[k - 1]) || !starts_nocase(f.p + k, f.len - k, "src")) continue;
      uint32_t j = k + 3;
      while (j < f.len && ascii_space(f.p[j])) j++;
      if (j >= f.len || f.p[j] != '=') continue;
      j++;
      while (j < f.len && ascii_space(f.p[j])) j++;
      if (j >= f.len || (f.p[j] != '"' && f.p[j] != '\'')) continue;
      uint32_t a = ++j;
      while (j < f.len && f.p[j] != '"' && f.p[j] != '\'') j++;
      if (j > a && j < f.len) return (wire_str){f.p + a, j - a};
    }
  }
  return (wire_str){"", 0};
}
/* /\[sound:[^\]]*\]/ or /<audio\b[^>]*src=/i */
int has_audio_ref(wire_str f) {
  for (uint32_t i = 0; i < f.len; i++) {
    if (f.len - i >= 7 && same(f.p + i, 7, "[sound:", 7)) {
      for (uint32_t k = i + 7; k < f.len; k++)
        if (f.p[k] == ']') return 1;
    }
    if (starts_nocase(f.p + i, f.len - i, "<audio")) {
      uint32_t k = i + 6;
      char b = k < f.len ? lower(f.p[k]) : 0;
      if ((b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_') continue; /* \b */
      for (; k + 4 <= f.len && f.p[k] != '>'; k++)
        if (starts_nocase(f.p + k, f.len - k, "src=")) return 1;
    }
  }
  return 0;
}

/* lyricsParse.js's TRAILING_PUNCTUATION_RE's class: \s and these. */
static int trailing_punct(uint32_t c) {
  static const uint32_t SET[] = {',', '.', '!', '?', ';', ':', 0x3001, 0x3002, 0xff01, 0xff1f, 0xff0c, 0xff1b, 0xff1a,
                                 0x2026, '"', '\'', 0x201c, 0x201d, 0x2018, 0x2019};
  if (is_space(c)) return 1;
  for (uint32_t i = 0; i < sizeof SET / sizeof *SET; i++)
    if (SET[i] == c) return 1;
  return 0;
}
uint32_t dedupe_key(char *dst, wire_str s) {
  wire_str t = trim(s);
  if (t.len) __builtin_memmove(dst, t.p, t.len);
  uint32_t n = collapse(dst, t.len), end = n, cl;
  while (end > 0) {
    uint32_t i = cp_start(dst, end);
    if (!trailing_punct(cp_at(dst, n, i, &cl)) || i + cl != end) break;
    end = i;
  }
  return end ? end : n;
}
