/* The small things the collection core is built from: an arena per call, a growable buffer, UTF-8
 * text as (pointer, length), and the handful of JavaScript and Node behaviours the Node code this
 * replaces relied on (String.prototype.trim, toLowerCase, normalize('NFC'), Number's toString,
 * path.resolve and friends), each written to answer exactly as they did. ICU is the one Node is
 * built with (server/Makefile pins its major), so case and normalisation tables are the same. */
#ifndef AMGI_COL_UTIL_H
#define AMGI_COL_UTIL_H
#include <stddef.h>
#include <stdint.h>

/* ---- arena: everything a call allocates, freed at once ---- */
typedef struct arena_chunk arena_chunk;
typedef struct { arena_chunk *head; } arena;
void *ar_alloc(arena *a, size_t n);          /* zeroed, 16-aligned; aborts when memory is out */
char *ar_dup(arena *a, const void *p, size_t n); /* n bytes and a NUL */
char *ar_fmt(arena *a, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void ar_free(arena *a);

/* ---- text: UTF-8 bytes, not NUL-terminated in general (a field may hold a NUL) ---- */
typedef struct { const char *p; size_t n; } str;
#define S(lit) ((str){(lit), sizeof(lit) - 1})
str str_c(const char *s);
int str_eq(str a, str b);
int str_eq_c(str a, const char *s);
int str_starts(str s, str prefix);
str str_sub(str s, size_t from, size_t to);
str str_cat(arena *a, str x, str y);
str str_cat3(arena *a, str x, str y, str z);
const char *str_z(arena *a, str s); /* a NUL-terminated copy */

/* ---- a growable buffer (malloc'd; buf_free, or buf_str into an arena) ---- */
typedef struct { char *p; size_t n, cap; } buf;
void buf_put(buf *b, const void *p, size_t n);
void buf_s(buf *b, str s);
void buf_c(buf *b, const char *s);
void buf_ch(buf *b, char c);
void buf_fmt(buf *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
str buf_str(arena *a, const buf *b);
void buf_free(buf *b);

/* ---- UTF-8 ---- */
/* The code point at s[*at], advancing *at; an invalid sequence reads as U+FFFD, a maximal subpart at
 * a time, as the WHATWG decoder (and so Node's Buffer.toString('utf8')) reads it. */
uint32_t utf8_next(str s, size_t *at);
void utf8_put(buf *b, uint32_t cp); /* a surrogate code point is written as U+FFFD, as Node writes a lone one */
str utf8_clean(arena *a, str s);    /* s with every invalid sequence replaced, as Node decodes bytes */

/* JavaScript's whitespace (String.prototype.trim, the regexp \s): WhiteSpace and LineTerminator. */
int js_space(uint32_t cp);
str js_trim(str s);
/* String.prototype.toLowerCase (locale-independent, full mappings, final sigma) and normalize('NFC'). */
str js_lower(arena *a, str s);
str js_nfc(arena *a, str s);
/* Anki's unicase collation's fold (see util.c): full case folding, a three-code-point fold
 * reordered as the crate Anki is built with yields it. "Straße" and "STRASSE" fold the same; "ﬃ"
 * folds to "iff", so it is not "FFI" (Anki says the same). As code points, and as UTF-8. */
size_t unicase_fold32(arena *a, str s, uint32_t **out);
str case_fold(arena *a, str s);
/* a < b as JavaScript compares strings: by UTF-16 code unit. */
int js_cmp(str a, str b);
/* String.prototype.localeCompare in the default locale, as Node's Intl collation answers. */
int js_locale_cmp(str a, str b);

/* Number.prototype.toString for a double (shortest round trip; exponent past 1e21 and below 1e-6). */
void js_num(buf *b, double v);
/* A decimal integer string as JavaScript's Number() reads it into a whole number, or 0 with *ok 0. */
int64_t js_int(str s, int *ok);

/* ---- paths, as Node's path module (POSIX) answers ---- */
str path_resolve(arena *a, str p); /* against the working directory, . and .. folded, no trailing / */
str path_join(arena *a, str dir, str name);
str path_basename(arena *a, str p);
str path_dirname(arena *a, str p);
str path_extname(str p);

/* ---- hashes ---- */
void sha1_hex(const void *p, size_t n, char out[41]);
#endif
