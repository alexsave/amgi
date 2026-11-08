#include "util.h"

#include <errno.h>
#include <float.h>
#include <math.h>
#include <openssl/evp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unicode/ucol.h>
#include <unicode/unorm2.h>
#include <unicode/ustring.h>
#include <unicode/utf16.h>
#include <unistd.h>

static void oom(void) {
  fputs("amgi collection: out of memory\n", stderr);
  abort();
}

/* ---- arena ---- */
struct arena_chunk { arena_chunk *next; size_t used, cap; _Alignas(16) unsigned char data[]; };

void *ar_alloc(arena *a, size_t n) {
  n = (n + 15) & ~(size_t)15;
  if (!a->head || a->head->cap - a->head->used < n) {
    size_t cap = n > 65536 ? n : 65536;
    arena_chunk *c = malloc(sizeof *c + cap);
    if (!c) oom();
    c->next = a->head;
    c->used = 0;
    c->cap = cap;
    a->head = c;
  }
  void *p = a->head->data + a->head->used;
  a->head->used += n;
  memset(p, 0, n);
  return p;
}

char *ar_dup(arena *a, const void *p, size_t n) {
  char *q = ar_alloc(a, n + 1);
  if (n) memcpy(q, p, n);
  q[n] = 0;
  return q;
}

char *ar_fmt(arena *a, const char *fmt, ...) {
  va_list ap, ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  char *p = ar_alloc(a, (size_t)n + 1);
  vsnprintf(p, (size_t)n + 1, fmt, ap2);
  va_end(ap2);
  return p;
}

void ar_free(arena *a) {
  while (a->head) {
    arena_chunk *next = a->head->next;
    free(a->head);
    a->head = next;
  }
}

/* ---- str ---- */
str str_c(const char *s) { return (str){s, s ? strlen(s) : 0}; }
int str_eq(str a, str b) { return a.n == b.n && (a.n == 0 || !memcmp(a.p, b.p, a.n)); }
int str_eq_c(str a, const char *s) { return str_eq(a, str_c(s)); }
int str_starts(str s, str prefix) { return s.n >= prefix.n && (prefix.n == 0 || !memcmp(s.p, prefix.p, prefix.n)); }
str str_sub(str s, size_t from, size_t to) {
  if (to > s.n) to = s.n;
  if (from > to) from = to;
  return (str){s.p + from, to - from};
}
str str_cat(arena *a, str x, str y) {
  char *p = ar_alloc(a, x.n + y.n + 1);
  if (x.n) memcpy(p, x.p, x.n);
  if (y.n) memcpy(p + x.n, y.p, y.n);
  return (str){p, x.n + y.n};
}
str str_cat3(arena *a, str x, str y, str z) { return str_cat(a, str_cat(a, x, y), z); }
const char *str_z(arena *a, str s) { return ar_dup(a, s.p, s.n); }

/* ---- buf ---- */
void buf_put(buf *b, const void *p, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 64;
    while (cap < b->n + n + 1) cap *= 2;
    char *q = realloc(b->p, cap);
    if (!q) oom();
    b->p = q;
    b->cap = cap;
  }
  if (n) memcpy(b->p + b->n, p, n);
  b->n += n;
  b->p[b->n] = 0;
}
void buf_s(buf *b, str s) { buf_put(b, s.p, s.n); }
void buf_c(buf *b, const char *s) { buf_put(b, s, strlen(s)); }
void buf_ch(buf *b, char c) { buf_put(b, &c, 1); }
void buf_fmt(buf *b, const char *fmt, ...) {
  va_list ap, ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  buf_put(b, "", 0);
  if (b->n + (size_t)n + 1 > b->cap) {
    buf_put(b, "", 0);
    size_t cap = b->cap;
    while (cap < b->n + (size_t)n + 1) cap *= 2;
    char *q = realloc(b->p, cap);
    if (!q) oom();
    b->p = q;
    b->cap = cap;
  }
  vsnprintf(b->p + b->n, (size_t)n + 1, fmt, ap2);
  va_end(ap2);
  b->n += (size_t)n;
}
str buf_str(arena *a, const buf *b) { return (str){ar_dup(a, b->p ? b->p : "", b->n), b->n}; }
void buf_free(buf *b) {
  free(b->p);
  *b = (buf){0};
}

/* ---- UTF-8 ---- */
uint32_t utf8_next(str s, size_t *at) {
  const unsigned char *p = (const unsigned char *)s.p;
  size_t i = *at;
  unsigned c = p[i];
  if (c < 0x80) {
    *at = i + 1;
    return c;
  }
  int need;
  uint32_t cp;
  unsigned lo = 0x80, hi = 0xbf;
  if (c >= 0xc2 && c <= 0xdf) need = 1, cp = c & 0x1f;
  else if (c >= 0xe0 && c <= 0xef) {
    need = 2, cp = c & 0x0f;
    if (c == 0xe0) lo = 0xa0;
    if (c == 0xed) hi = 0x9f;
  } else if (c >= 0xf0 && c <= 0xf4) {
    need = 3, cp = c & 0x07;
    if (c == 0xf0) lo = 0x90;
    if (c == 0xf4) hi = 0x8f;
  } else {
    *at = i + 1;
    return 0xfffd;
  }
  i++;
  for (int k = 0; k < need; k++) {
    if (i >= s.n || p[i] < lo || p[i] > hi) {
      *at = i;
      return 0xfffd;
    }
    cp = (cp << 6) | (p[i] & 0x3f);
    lo = 0x80, hi = 0xbf;
    i++;
  }
  *at = i;
  return cp;
}

void utf8_put(buf *b, uint32_t cp) {
  char t[4];
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  if (cp < 0x80) {
    t[0] = (char)cp;
    buf_put(b, t, 1);
  } else if (cp < 0x800) {
    t[0] = (char)(0xc0 | cp >> 6), t[1] = (char)(0x80 | (cp & 0x3f));
    buf_put(b, t, 2);
  } else if (cp < 0x10000) {
    t[0] = (char)(0xe0 | cp >> 12), t[1] = (char)(0x80 | ((cp >> 6) & 0x3f)), t[2] = (char)(0x80 | (cp & 0x3f));
    buf_put(b, t, 3);
  } else {
    t[0] = (char)(0xf0 | cp >> 18), t[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
    t[2] = (char)(0x80 | ((cp >> 6) & 0x3f)), t[3] = (char)(0x80 | (cp & 0x3f));
    buf_put(b, t, 4);
  }
}

str utf8_clean(arena *a, str s) {
  size_t at = 0;
  int clean = 1;
  while (at < s.n) {
    size_t before = at;
    uint32_t cp = utf8_next(s, &at);
    if (cp == 0xfffd && !(at - before == 3 && (unsigned char)s.p[before] == 0xef)) clean = 0;
  }
  if (clean) return s;
  buf b = {0};
  for (at = 0; at < s.n;) utf8_put(&b, utf8_next(s, &at));
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

int js_space(uint32_t c) {
  return c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || c == 0x20 || c == 0xa0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 ||
         c == 0xfeff;
}

str js_trim(str s) {
  size_t start = 0, end = s.n;
  while (start < end) {
    size_t at = start;
    if (!js_space(utf8_next(s, &at))) break;
    start = at;
  }
  /* From the end: step back to the start of the last code point each time. */
  while (end > start) {
    size_t k = end - 1;
    while (k > start && ((unsigned char)s.p[k] & 0xc0) == 0x80) k--;
    size_t at = k;
    if (!js_space(utf8_next(s, &at)) || at != end) break;
    end = k;
  }
  return str_sub(s, start, end);
}

/* UTF-8 to UTF-16 and back, through ICU. */
static UChar *to16(arena *a, str s, int32_t *len) {
  UErrorCode e = U_ZERO_ERROR;
  u_strFromUTF8WithSub(NULL, 0, len, s.p, (int32_t)s.n, 0xfffd, NULL, &e);
  UChar *u = ar_alloc(a, sizeof(UChar) * ((size_t)*len + 1));
  e = U_ZERO_ERROR;
  u_strFromUTF8WithSub(u, *len + 1, len, s.p, (int32_t)s.n, 0xfffd, NULL, &e);
  return u;
}
static str to8(arena *a, const UChar *u, int32_t len) {
  UErrorCode e = U_ZERO_ERROR;
  int32_t n;
  u_strToUTF8WithSub(NULL, 0, &n, u, len, 0xfffd, NULL, &e);
  char *p = ar_alloc(a, (size_t)n + 1);
  e = U_ZERO_ERROR;
  u_strToUTF8WithSub(p, n + 1, &n, u, len, 0xfffd, NULL, &e);
  return (str){p, (size_t)n};
}

str js_lower(arena *a, str s) {
  int ascii = 1;
  for (size_t i = 0; i < s.n && ascii; i++)
    if ((unsigned char)s.p[i] >= 0x80) ascii = 0;
  if (ascii) {
    char *p = ar_dup(a, s.p, s.n);
    for (size_t i = 0; i < s.n; i++)
      if (p[i] >= 'A' && p[i] <= 'Z') p[i] = (char)(p[i] + 32);
    return (str){p, s.n};
  }
  int32_t n;
  UChar *u = to16(a, s, &n);
  UErrorCode e = U_ZERO_ERROR;
  int32_t m = u_strToLower(NULL, 0, u, n, "", &e);
  UChar *out = ar_alloc(a, sizeof(UChar) * ((size_t)m + 1));
  e = U_ZERO_ERROR;
  u_strToLower(out, m + 1, u, n, "", &e);
  return to8(a, out, m);
}

/* unicase's fold, one code point at a time: ICU's full case folding (CaseFolding.txt C and F, which
 * the unicase crate's table is), except that a fold to three code points comes out as the crate
 * Anki is built with yields it, third first: U+FB03 (ffi) folds to "iff", U+0390 to (U+0301, U+03B9,
 * U+0308). Measured against Anki 26.09's own collation; matching it exactly is what keeps the name
 * indexes Anki builds valid when C writes them. */
size_t unicase_fold32(arena *a, str s, uint32_t **out) {
  size_t cap = s.n + 8, n = 0;
  uint32_t *f = ar_alloc(a, cap * sizeof *f);
  for (size_t at = 0; at < s.n;) {
    uint32_t cp = utf8_next(s, &at);
    UChar in[2], fold[8];
    int32_t len = 0, m;
    U16_APPEND_UNSAFE(in, len, cp);
    UErrorCode e = U_ZERO_ERROR;
    m = u_strFoldCase(fold, 8, in, len, U_FOLD_CASE_DEFAULT, &e);
    uint32_t cps[4];
    int k = 0;
    for (int32_t i = 0; i < m && k < 4;) {
      UChar32 c;
      U16_NEXT(fold, i, m, c);
      cps[k++] = (uint32_t)c;
    }
    if (n + 4 > cap) {
      uint32_t *more = ar_alloc(a, cap * 2 * sizeof *more);
      memcpy(more, f, n * sizeof *f);
      f = more;
      cap *= 2;
    }
    if (k == 3) {
      f[n++] = cps[2];
      f[n++] = cps[0];
      f[n++] = cps[1];
    } else {
      for (int i = 0; i < k; i++) f[n++] = cps[i];
    }
  }
  *out = f;
  return n;
}

str case_fold(arena *a, str s) {
  uint32_t *f;
  size_t n = unicase_fold32(a, s, &f);
  buf b = {0};
  for (size_t i = 0; i < n; i++) utf8_put(&b, f[i]);
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

str js_nfc(arena *a, str s) {
  int ascii = 1;
  for (size_t i = 0; i < s.n && ascii; i++)
    if ((unsigned char)s.p[i] >= 0x80) ascii = 0;
  if (ascii) return s;
  UErrorCode e = U_ZERO_ERROR;
  const UNormalizer2 *nfc = unorm2_getNFCInstance(&e);
  int32_t n;
  UChar *u = to16(a, s, &n);
  e = U_ZERO_ERROR;
  int32_t m = unorm2_normalize(nfc, u, n, NULL, 0, &e);
  UChar *out = ar_alloc(a, sizeof(UChar) * ((size_t)m + 1));
  e = U_ZERO_ERROR;
  unorm2_normalize(nfc, u, n, out, m + 1, &e);
  return to8(a, out, m);
}

int js_cmp(str a, str b) {
  size_t i = 0, j = 0;
  while (i < a.n && j < b.n) {
    uint32_t x = utf8_next(a, &i), y = utf8_next(b, &j);
    if (x == y) continue;
    /* Two supplementary code points compare as their surrogate pairs do, which is code point
     * order; against a BMP one, a supplementary one is its high surrogate. */
    uint32_t kx = x >= 0x10000 && y < 0x10000 ? 0xd800 + ((x - 0x10000) >> 10) : x;
    uint32_t ky = y >= 0x10000 && x < 0x10000 ? 0xd800 + ((y - 0x10000) >> 10) : y;
    return kx < ky ? -1 : 1;
  }
  return i < a.n ? 1 : j < b.n ? -1 : 0;
}

int js_locale_cmp(str a, str b) {
  UErrorCode e = U_ZERO_ERROR;
  UCollator *c = ucol_open("", &e);
  if (U_FAILURE(e)) return js_cmp(a, b);
  e = U_ZERO_ERROR;
  UCollationResult r = ucol_strcollUTF8(c, a.p, (int32_t)a.n, b.p, (int32_t)b.n, &e);
  ucol_close(c);
  return r == UCOL_LESS ? -1 : r == UCOL_GREATER ? 1 : 0;
}

void js_num(buf *b, double v) {
  if (isnan(v)) {
    buf_c(b, "NaN");
    return;
  }
  if (isinf(v)) {
    buf_c(b, v < 0 ? "-Infinity" : "Infinity");
    return;
  }
  if (v == 0) {
    buf_c(b, "0");
    return;
  }
  if (v < 0) {
    buf_ch(b, '-');
    v = -v;
  }
  /* The shortest digits that read back as v: the first precision whose correctly rounded form does. */
  char e[40], digits[24];
  int k = 0, exp10 = 0;
  for (int prec = 0; prec < 17; prec++) {
    snprintf(e, sizeof e, "%.*e", prec, v);
    if (strtod(e, NULL) == v) break;
  }
  for (const char *p = e; *p && *p != 'e'; p++)
    if (*p >= '0' && *p <= '9') digits[k++] = *p;
  exp10 = atoi(strchr(e, 'e') + 1);
  while (k > 1 && digits[k - 1] == '0') k--;
  digits[k] = 0;
  int n = exp10 + 1; /* where the decimal point goes, counted from the first digit */
  if (k <= n && n <= 21) {
    buf_put(b, digits, (size_t)k);
    for (int i = k; i < n; i++) buf_ch(b, '0');
  } else if (0 < n && n <= 21) {
    buf_put(b, digits, (size_t)n);
    buf_ch(b, '.');
    buf_put(b, digits + n, (size_t)(k - n));
  } else if (-6 < n && n <= 0) {
    buf_c(b, "0.");
    for (int i = 0; i < -n; i++) buf_ch(b, '0');
    buf_put(b, digits, (size_t)k);
  } else {
    buf_ch(b, digits[0]);
    if (k > 1) {
      buf_ch(b, '.');
      buf_put(b, digits + 1, (size_t)(k - 1));
    }
    buf_fmt(b, "e%c%d", n - 1 >= 0 ? '+' : '-', abs(n - 1));
  }
}

int64_t js_int(str s, int *ok) {
  char tmp[32];
  *ok = 0;
  if (s.n == 0 || s.n >= sizeof tmp) return 0;
  memcpy(tmp, s.p, s.n);
  tmp[s.n] = 0;
  char *end;
  errno = 0;
  long long v = strtoll(tmp, &end, 10);
  if (errno || *end) return 0;
  *ok = 1;
  return v;
}

/* ---- paths ---- */
/* path.normalize for POSIX: . and empty segments dropped, .. folded (never above an absolute root). */
static str normalize(arena *a, str p) {
  int abs_ = p.n && p.p[0] == '/';
  int trailing = p.n && p.p[p.n - 1] == '/';
  str *seg = ar_alloc(a, sizeof(str) * (p.n / 2 + 2));
  size_t ns = 0;
  for (size_t i = 0; i < p.n;) {
    size_t j = i;
    while (j < p.n && p.p[j] != '/') j++;
    str part = str_sub(p, i, j);
    if (part.n == 0 || str_eq_c(part, ".")) {
    } else if (str_eq_c(part, "..")) {
      if (ns && !str_eq_c(seg[ns - 1], "..")) ns--;
      else if (!abs_) seg[ns++] = part;
    } else {
      seg[ns++] = part;
    }
    i = j + 1;
  }
  buf b = {0};
  if (abs_) buf_ch(&b, '/');
  for (size_t i = 0; i < ns; i++) {
    if (i) buf_ch(&b, '/');
    buf_s(&b, seg[i]);
  }
  if (b.n == 0) buf_ch(&b, '.');
  if (trailing && !(b.n == 1 && b.p[0] == '/')) buf_ch(&b, '/');
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

str path_resolve(arena *a, str p) {
  str full = p;
  if (!(p.n && p.p[0] == '/')) {
    char cwd[4096];
    if (!getcwd(cwd, sizeof cwd)) cwd[0] = '/', cwd[1] = 0;
    full = str_cat3(a, str_c(ar_dup(a, cwd, strlen(cwd))), S("/"), p);
  }
  str n = normalize(a, full);
  if (n.n > 1 && n.p[n.n - 1] == '/') n.n--;
  return n;
}

str path_join(arena *a, str dir, str name) {
  if (dir.n == 0 && name.n == 0) return S(".");
  if (dir.n == 0) return normalize(a, name);
  if (name.n == 0) return normalize(a, dir);
  return normalize(a, str_cat3(a, dir, S("/"), name));
}

str path_basename(arena *a, str p) {
  size_t end = p.n;
  while (end > 0 && p.p[end - 1] == '/') end--;
  size_t start = end;
  while (start > 0 && p.p[start - 1] != '/') start--;
  return (str){ar_dup(a, p.p + start, end - start), end - start};
}

str path_dirname(arena *a, str p) {
  if (p.n == 0) return S(".");
  size_t end = p.n;
  while (end > 1 && p.p[end - 1] == '/') end--;
  while (end > 0 && p.p[end - 1] != '/') end--;
  while (end > 1 && p.p[end - 1] == '/') end--;
  if (end == 0) return S(p.p[0] == '/' ? "/" : ".");
  return (str){ar_dup(a, p.p, end), end};
}

str path_extname(str p) {
  long start_dot = -1, start_part = 0, end = -1;
  int matched_slash = 1, pre_dot = 0;
  for (long i = (long)p.n - 1; i >= 0; i--) {
    char c = p.p[i];
    if (c == '/') {
      if (!matched_slash) {
        start_part = i + 1;
        break;
      }
      continue;
    }
    if (end == -1) {
      matched_slash = 0;
      end = i + 1;
    }
    if (c == '.') {
      if (start_dot == -1) start_dot = i;
      else if (pre_dot != 1) pre_dot = 1;
    } else if (start_dot != -1) {
      pre_dot = -1;
    }
  }
  if (start_dot == -1 || end == -1 || pre_dot == 0 ||
      (pre_dot == 1 && start_dot == end - 1 && start_dot == start_part + 1))
    return (str){p.p + p.n, 0};
  return str_sub(p, (size_t)start_dot, (size_t)end);
}

void sha1_hex(const void *p, size_t n, char out[41]) {
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int len = 0;
  EVP_Digest(p, n, md, &len, EVP_sha1(), NULL);
  for (unsigned i = 0; i < 20; i++) snprintf(out + 2 * i, 3, "%02x", md[i]);
}
