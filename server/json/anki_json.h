/* The one JSON reader and writer in amgi's C, quarantined in this folder (tests/repo/no-json.test.mjs
 * fails on JSON parsed or formatted in C anywhere else, and counts every call to these two named
 * functions per file against its list of reasons).
 *
 * Why it exists: Anki's own formats. A schema 11 collection keeps its decks, note types and config
 * as JSON text in the col table (col.decks, col.models, col.conf), and a schema 18 collection
 * keeps each config value as JSON in the config table. The collection core reads and rewrites
 * them as Anki defines them, exactly as the Node code it replaces did with JSON.parse and
 * JSON.stringify, so the bytes it writes are the bytes Node wrote:
 *   - numbers are doubles, written back by JavaScript's Number to string rules ("1e+21", "0.9");
 *   - an object's keys come out in JavaScript's property order: keys that are array indexes
 *     ("1", "42") first, ascending, then every other key in the order it was first set (a deck id
 *     like "1794169279580" is past 2^32, so it is an ordinary key, in insertion order);
 *   - a key set again keeps its place; strings are escaped as JSON.stringify escapes them (a lone
 *     surrogate as \udxxx), and everything else is written raw.
 * The values themselves (aj, below) are plain data, and reading or changing them is not JSON. */
#ifndef AMGI_ANKI_JSON_H
#define AMGI_ANKI_JSON_H
#include "../collection/util.h"

enum { AJ_NULL, AJ_BOOL, AJ_NUM, AJ_STR, AJ_ARR, AJ_OBJ };
typedef struct aj aj;
typedef struct { str key; aj *value; } aj_entry;
struct aj {
  int type;
  int b;
  double num;
  str s; /* WTF-8: UTF-8, with a lone surrogate from a \u escape kept as its three-byte form */
  aj **items;
  size_t n, cap; /* items of an array */
  aj_entry *entries;
  size_t ne, ecap; /* entries of an object, in the order first set */
};

/* JSON.parse: the value, or NULL with *error set to why. */
aj *anki_json_parse(arena *a, str text, const char **error);
/* JSON.stringify of a value read by anki_json_parse and changed with the functions below. */
str anki_json_stringify(arena *a, const aj *v);

aj *aj_null(arena *a);
aj *aj_bool(arena *a, int b);
aj *aj_num(arena *a, double v);
aj *aj_str(arena *a, str s);
aj *aj_obj(arena *a);
aj *aj_arr(arena *a);
void aj_push(arena *a, aj *arr, aj *v);
aj *aj_get(const aj *obj, str key);           /* NULL when absent (or obj is not an object) */
void aj_set(arena *a, aj *obj, str key, aj *v); /* a new key at the end, an old one in its place */
int aj_del(aj *obj, str key);                   /* 1 when it was there */
/* The keys of obj in JavaScript's property order (Object.keys); n set to their count. */
str *aj_keys(arena *a, const aj *obj, size_t *n);
#endif
