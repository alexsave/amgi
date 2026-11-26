/* The lines a pasted text makes cards of, and the key two lines are compared by: what were
 * lyricsParse.js's parseLyricsPaste and normalizeForDedupe. One owner for everything that reads
 * phrases in bulk: the deck page's box (ui/src/form.c, bulk.c) and the command line's
 * `amgi card add --file` (server/cli/amgi.c).
 * Plain C on UTF-8 bytes, no allocation and no C library, so the page's wasm and the native
 * programs build the same file. tests/ui/text.test.mjs holds it to what the JS answered. */
#ifndef AMGI_LINES_H
#define AMGI_LINES_H
#include "wire.h"

/* A paste longer than this is refused whole ("make them in parts"): nothing is read cut short. */
#define LINES_MAX_BYTES 65536u
/* The most lines one run makes; the lines after it are not made. */
#define LINES_MAX 500u

/* The code point at s[i] (UTF-8) and its length in *n; a stray byte reads as itself, length 1. */
uint32_t lines_cp(const char *s, uint32_t len, uint32_t i, uint32_t *n);
/* The start of the code point that ends at s[end - 1]. */
uint32_t lines_cp_start(const char *s, uint32_t end);
/* JS's \s: WhiteSpace and LineTerminator. */
int lines_space(uint32_t c);
/* JS's String.prototype.trim. */
wire_str lines_trim(wire_str s);
/* Runs of \s as one space, in place over dst (n bytes); returns the new length. */
uint32_t lines_collapse(char *dst, uint32_t n);
/* normalizeForDedupe, into dst (s.len bytes): white space trimmed and collapsed, the trailing run
 * of white space and punctuation dropped (unless that is all there is). Two lines are the same
 * phrase when their keys are the same bytes (case and accents count). */
uint32_t lines_key(char *dst, wire_str s);

/* Reading a paste a line at a time. A line ends at \r\n, \r or \n; each is trimmed; a blank line
 * and a line that is one [bracketed] section marker are passed over without a word; a line whose
 * key an earlier line had is a LINE_REPEAT, any other a LINE_CARD. keys needs len + 1 bytes. */
enum { LINE_END, LINE_CARD, LINE_REPEAT };
typedef struct { uint32_t at, n; } lines_key_ref;
typedef struct {
    const char *s;
    uint32_t len, at, used, cards;
    char *keys;
    lines_key_ref refs[512]; /* the first 512 card lines' keys: a repeat of a later one is made again */
} lines_reader;
void lines_open(lines_reader *r, const char *s, uint32_t len, char *keys);
/* LINE_CARD or LINE_REPEAT with *line (pointing into s), or LINE_END. */
int lines_next(lines_reader *r, wire_str *line);
/* parseLyricsPaste: the LINE_CARD lines in order, at most cap of them into out; returns how many
 * there are in all. keys needs len + 1 bytes. */
uint32_t lines_split(const char *s, uint32_t len, wire_str *out, uint32_t cap, char *keys);
#endif
