/* The collection-parity dump: a collection.anki2 (and its media folder and backups) as text, row by
 * row, with what differs from run to run normalised away and nothing else. Two runs of the same
 * operation list, one through the Node collection code and one through the C one, must dump to the
 * same text (tests/server/parity/collection.test.mjs).
 *
 *   parity_dump --since <ms> --until <ms> <collection.anki2> [<media dir>] [<backup dir>]
 *
 * What is normalised, and only inside the run's window [since, until] (a value from before the run
 * is the fixture's own, the same bytes in both runs, and is printed as it is):
 *   - ids: a deck, note type, note, card or deck options id made during the run is <D1>, <N2>, ...,
 *     numbered in id order within its kind. Its references (cards.did, notes.mid, graves, a
 *     "_deck_<id>_" config key, the schema 11 JSON columns) get the same name.
 *   - times: any other integer in the window is <Tms> (milliseconds) or <Ts> (seconds).
 *   - guids of notes made during the run are <G>, after checking they are base91 and unique.
 *   - the random 64-bit ids Anki keeps on a new note type's fields and templates are <rand>.
 * Everything else is exact: the schema text (sqlite_master, so a collation relaxed for a write and
 * not restored shows), every cell, the JSON columns' own bytes (key order included), the protobuf
 * blobs field by field, the integrity check, every media file's name, size and hash, and the
 * backups (how many, and each one's rows).
 *
 * The unicase collation is registered (ICU's full case folding, which is what the unicase crate
 * Anki uses does), so the WITHOUT ROWID tables can be read and the integrity check can check the
 * name indexes. This is a test tool: it is not shipped, and the no-JSON scan does not cover it. */
#include <dirent.h>
#include <inttypes.h>
#include <sqlite3.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unicode/unorm2.h>
#include <unicode/ustring.h>

static int64_t since_ms, until_ms;
static int failures;

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "parity_dump: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  exit(2);
}

static void *xrealloc(void *p, size_t n) {
  void *q = realloc(p, n ? n : 1);
  if (!q) die("out of memory");
  return q;
}

/* ---- a growable string ---- */
typedef struct { char *p; size_t n, cap; } buf;
static void bput(buf *b, const void *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    b->cap = (b->n + n + 1) * 2;
    b->p = xrealloc(b->p, b->cap);
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}
static void bstr(buf *b, const char *s) { bput(b, s, strlen(s)); }
static void bfmt(buf *b, const char *fmt, ...) {
  char tmp[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n < 0 || (size_t)n >= sizeof tmp) die("format overflow");
  bput(b, tmp, (size_t)n);
}

/* ---- unicase: ICU full case folding, then code point order ---- */
static UChar *to_utf16(const void *s, int n, int32_t *len) {
  UErrorCode e = U_ZERO_ERROR;
  u_strFromUTF8(NULL, 0, len, s, n, &e);
  e = U_ZERO_ERROR;
  UChar *u = xrealloc(NULL, sizeof(UChar) * (size_t)(*len + 1));
  u_strFromUTF8(u, *len + 1, len, s, n, &e);
  if (U_FAILURE(e)) *len = 0;
  return u;
}
static int unicase(void *ctx, int na, const void *a, int nb, const void *b) {
  (void)ctx;
  int32_t la, lb;
  UChar *ua = to_utf16(a, na, &la), *ub = to_utf16(b, nb, &lb);
  UErrorCode e = U_ZERO_ERROR;
  int r = u_strCaseCompare(ua, la, ub, lb, U_FOLD_CASE_DEFAULT | U_COMPARE_CODE_POINT_ORDER, &e);
  free(ua);
  free(ub);
  return r < 0 ? -1 : r > 0;
}

/* ---- id spaces ---- */
enum { SP_DECK, SP_NOTETYPE, SP_NOTE, SP_CARD, SP_DCONF, SPACES };
static const char SP_LETTER[SPACES] = {'D', 'M', 'N', 'C', 'O'};
typedef struct { int64_t *v; size_t n, cap; } idset;
static idset spaces[SPACES];

static int in_ms(int64_t v) { return v >= since_ms && v <= until_ms + 60000; }
static int in_s(int64_t v) { return v >= since_ms / 1000 && v <= until_ms / 1000 + 60; }

static void note_id(int sp, int64_t v) {
  if (!in_ms(v)) return;
  idset *s = &spaces[sp];
  for (size_t i = 0; i < s->n; i++)
    if (s->v[i] == v) return;
  if (s->n == s->cap) {
    s->cap = s->cap ? s->cap * 2 : 16;
    s->v = xrealloc(s->v, s->cap * sizeof *s->v);
  }
  s->v[s->n++] = v;
}
static int cmp64(const void *a, const void *b) {
  int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
  return x < y ? -1 : x > y;
}
/* The index (from 1) of v in space sp, or 0. */
static size_t id_index(int sp, int64_t v) {
  idset *s = &spaces[sp];
  for (size_t i = 0; i < s->n; i++)
    if (s->v[i] == v) return i + 1;
  return 0;
}

/* A column that holds a time, never an id: printed as a time even when it equals an id. */
#define SP_TIME (-2)

/* An integer as the dump prints it, preferring space sp (-1: none) for an id. */
static void put_int(buf *b, int64_t v, int sp) {
  if (sp == SP_TIME) {
    if (in_ms(v)) bstr(b, "<Tms>");
    else if (in_s(v)) bstr(b, "<Ts>");
    else bfmt(b, "%" PRId64, v);
    return;
  }
  int order[SPACES + 1], k = 0;
  if (sp >= 0) order[k++] = sp;
  for (int s = 0; s < SPACES; s++)
    if (s != sp) order[k++] = s;
  for (int i = 0; i < k; i++) {
    size_t idx = id_index(order[i], v);
    if (idx) {
      bfmt(b, "<%c%zu>", SP_LETTER[order[i]], idx);
      return;
    }
  }
  if (in_ms(v)) bstr(b, "<Tms>");
  else if (in_s(v)) bstr(b, "<Ts>");
  else bfmt(b, "%" PRId64, v);
}

/* ---- text: every run of digits normalised as an integer (ids, times), the rest escaped ---- */
static int json_space_for_key(const char *k, size_t n) {
  struct { const char *key; int sp; } map[] = {
    {"curDeck", SP_DECK}, {"activeDecks", SP_DECK}, {"did", SP_DECK}, {"lastDeck", SP_DECK},
    {"curModel", SP_NOTETYPE}, {"mid", SP_NOTETYPE}, {"lastNotetype", SP_NOTETYPE},
    {"conf", SP_DCONF}, {"mod", SP_TIME}, {"mtime", SP_TIME},
  };
  for (size_t i = 0; i < sizeof map / sizeof *map; i++)
    if (strlen(map[i].key) == n && !memcmp(map[i].key, k, n)) return map[i].sp;
  return -1;
}

static void put_text(buf *b, const unsigned char *s, size_t n, int sp) {
  /* The last JSON key seen (a quoted string followed by ':'), for which space a number is in. */
  const unsigned char *key = NULL;
  size_t keyn = 0;
  for (size_t i = 0; i < n;) {
    unsigned char c = s[i];
    if (c >= '0' && c <= '9' && (i == 0 || !(s[i - 1] >= '0' && s[i - 1] <= '9') )) {
      size_t j = i;
      int64_t v = 0;
      int over = 0;
      while (j < n && s[j] >= '0' && s[j] <= '9') {
        if (v > (INT64_MAX - 9) / 10) over = 1;
        v = v * 10 + (s[j] - '0');
        j++;
      }
      /* A decimal fraction or exponent is a real number, not an id: print it as it is. */
      if (over || (j < n && (s[j] == '.' || s[j] == 'e' || s[j] == 'E'))) {
        bput(b, s + i, j - i);
      } else {
        int ksp = key ? json_space_for_key((const char *)key, keyn) : -1;
        put_int(b, v, ksp != -1 ? ksp : sp);
      }
      i = j;
      continue;
    }
    if (c == '"') {
      size_t j = i + 1;
      while (j < n && s[j] != '"') j += s[j] == '\\' ? 2 : 1;
      if (j + 1 < n && s[j + 1] == ':') {
        key = s + i + 1;
        keyn = j - i - 1;
        /* "_deck_<id>_name" and "_nt_<id>_name" keys: the name after the id. */
        if (keyn > 1 && key[0] == '_') {
          const unsigned char *u = memchr(key + 1, '_', keyn - 1);
          const unsigned char *u2 = u ? memchr(u + 1, '_', keyn - (size_t)(u + 1 - key)) : NULL;
          if (u2) {
            keyn -= (size_t)(u2 + 1 - key);
            key = u2 + 1;
          }
        }
      }
    }
    if (c == '\\') bstr(b, "\\\\");
    else if (c == '\n') bstr(b, "\\n");
    else if (c < 0x20 || c == 0x7f) bfmt(b, "\\x%02x", c);
    else bput(b, &c, 1);
    i++;
  }
}

/* ---- protobuf: a blob as fields, when it is one whole message; else hex ---- */
static int pb_varint(const unsigned char *p, size_t n, size_t *at, uint64_t *v) {
  *v = 0;
  for (int shift = 0; shift < 64; shift += 7) {
    if (*at >= n) return 0;
    unsigned char c = p[(*at)++];
    *v |= (uint64_t)(c & 0x7f) << shift;
    if (!(c & 0x80)) return 1;
  }
  return 0;
}
static int pb_valid(const unsigned char *p, size_t n) {
  size_t at = 0;
  if (n == 0) return 1;
  while (at < n) {
    uint64_t tag, v;
    if (!pb_varint(p, n, &at, &tag) || (tag >> 3) == 0) return 0;
    switch (tag & 7) {
      case 0: if (!pb_varint(p, n, &at, &v)) return 0; break;
      case 1: if (n - at < 8) return 0; at += 8; break;
      case 5: if (n - at < 4) return 0; at += 4; break;
      case 2: if (!pb_varint(p, n, &at, &v) || v > n - at) return 0; at += v; break;
      default: return 0;
    }
  }
  return 1;
}
static void put_hex(buf *b, const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n; i++) bfmt(b, "%02x", p[i]);
}
/* mask: a field number whose varint is a random id (0: none). */
static void put_pb(buf *b, const unsigned char *p, size_t n, int mask, int depth) {
  size_t at = 0;
  bstr(b, "{");
  while (at < n) {
    uint64_t tag, v;
    pb_varint(p, n, &at, &tag);
    unsigned field = (unsigned)(tag >> 3);
    bfmt(b, "%s%u:", at > 0 && b->p[b->n - 1] != '{' ? " " : "", field);
    switch (tag & 7) {
      case 0:
        pb_varint(p, n, &at, &v);
        if (mask && (int)field == mask) bstr(b, "<rand>");
        else put_int(b, (int64_t)v, -1);
        break;
      case 1: bstr(b, "f64="); put_hex(b, p + at, 8); at += 8; break;
      case 5: bstr(b, "f32="); put_hex(b, p + at, 4); at += 4; break;
      case 2: {
        pb_varint(p, n, &at, &v);
        const unsigned char *q = p + at;
        size_t len = (size_t)v;
        at += len;
        /* Text when it is printable UTF-8 with no control bytes but tab and newline; a message when
         * it parses as one (and is not just text); else hex. */
        int text = 1;
        for (size_t i = 0; i < len; i++)
          if (q[i] < 0x20 && q[i] != '\n' && q[i] != '\t') text = 0;
        if (text && len > 0) {
          bstr(b, "\"");
          put_text(b, q, len, -1);
          bstr(b, "\"");
        } else if (depth < 6 && pb_valid(q, len)) {
          put_pb(b, q, len, 0, depth + 1);
        } else {
          bstr(b, "0x");
          put_hex(b, q, len);
        }
        break;
      }
    }
  }
  bstr(b, "}");
}

/* ---- the database ---- */
static sqlite3 *db;
static int schema_version;

static sqlite3_stmt *prep(const char *sql) {
  sqlite3_stmt *st;
  if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) die("%s: %s", sql, sqlite3_errmsg(db));
  return st;
}

/* Which space an integer column's values are in, or -1. graves.oid depends on the row's type. */
static int column_space(const char *table, const char *col) {
  struct { const char *t, *c; int sp; } map[] = {
    {"decks", "id", SP_DECK}, {"cards", "did", SP_DECK}, {"cards", "odid", SP_DECK},
    {"notetypes", "id", SP_NOTETYPE}, {"notes", "mid", SP_NOTETYPE}, {"fields", "ntid", SP_NOTETYPE},
    {"templates", "ntid", SP_NOTETYPE}, {"notes", "id", SP_NOTE}, {"cards", "nid", SP_NOTE},
    {"cards", "id", SP_CARD}, {"revlog", "cid", SP_CARD}, {"deck_config", "id", SP_DCONF},
    {"col", "crt", SP_TIME}, {"col", "mod", SP_TIME}, {"col", "scm", SP_TIME}, {"col", "ls", SP_TIME},
    {"notes", "mod", SP_TIME}, {"cards", "mod", SP_TIME}, {"decks", "mtime_secs", SP_TIME},
    {"notetypes", "mtime_secs", SP_TIME}, {"templates", "mtime_secs", SP_TIME}, {"fields", "mtime_secs", SP_TIME},
    {"config", "mtime_secs", SP_TIME}, {"deck_config", "mtime_secs", SP_TIME}, {"tags", "mtime_secs", SP_TIME},
  };
  for (size_t i = 0; i < sizeof map / sizeof *map; i++)
    if (!strcmp(map[i].t, table) && !strcmp(map[i].c, col)) return map[i].sp;
  return -1;
}

/* Every id made during the run, by space, before any row is printed. */
static void collect_ids(void) {
  struct { const char *sql; int sp; } reads[] = {
    {"SELECT id FROM decks", SP_DECK}, {"SELECT did FROM cards", SP_DECK}, {"SELECT odid FROM cards", SP_DECK},
    {"SELECT oid FROM graves WHERE type = 2", SP_DECK}, {"SELECT id FROM notetypes", SP_NOTETYPE},
    {"SELECT id FROM notes", SP_NOTE}, {"SELECT oid FROM graves WHERE type = 1", SP_NOTE},
    {"SELECT id FROM cards", SP_CARD}, {"SELECT oid FROM graves WHERE type = 0", SP_CARD},
    {"SELECT id FROM deck_config", SP_DCONF},
  };
  for (size_t i = 0; i < sizeof reads / sizeof *reads; i++) {
    sqlite3_stmt *st;
    if (sqlite3_prepare_v2(db, reads[i].sql, -1, &st, NULL) != SQLITE_OK) continue; /* no such table */
    while (sqlite3_step(st) == SQLITE_ROW) note_id(reads[i].sp, sqlite3_column_int64(st, 0));
    sqlite3_finalize(st);
  }
  if (schema_version == 11) {
    /* col.decks, col.models and col.dconf are JSON objects keyed by id: every key that is a number. */
    const char *cols[] = {"decks", "models", "dconf"};
    int sps[] = {SP_DECK, SP_NOTETYPE, SP_DCONF};
    for (int c = 0; c < 3; c++) {
      char sql[64];
      snprintf(sql, sizeof sql, "SELECT %s FROM col", cols[c]);
      sqlite3_stmt *st = prep(sql);
      if (sqlite3_step(st) == SQLITE_ROW) {
        const unsigned char *s = sqlite3_column_text(st, 0);
        size_t n = (size_t)sqlite3_column_bytes(st, 0);
        int depth = 0;
        for (size_t i = 0; i < n; i++) {
          if (s[i] == '{' || s[i] == '[') depth++;
          else if (s[i] == '}' || s[i] == ']') depth--;
          else if (s[i] == '"') {
            size_t j = i + 1;
            while (j < n && s[j] != '"') j += s[j] == '\\' ? 2 : 1;
            if (depth == 1 && j + 1 < n && s[j + 1] == ':') {
              int64_t v = 0;
              size_t k = i + 1;
              while (k < j && s[k] >= '0' && s[k] <= '9') v = v * 10 + (s[k++] - '0');
              if (k == j && j > i + 1) note_id(sps[c], v);
            }
            i = j;
          }
        }
      }
      sqlite3_finalize(st);
    }
  }
  for (int s = 0; s < SPACES; s++) qsort(spaces[s].v, spaces[s].n, sizeof(int64_t), cmp64);
}

static int cmpstr(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static const char BASE91[] =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

static void dump_table(const char *table) {
  char sql[256];
  snprintf(sql, sizeof sql, "SELECT * FROM \"%s\"", table);
  sqlite3_stmt *st = prep(sql);
  int ncol = sqlite3_column_count(st);
  char **rows = NULL;
  size_t nrows = 0, cap = 0;
  char **guids = NULL;
  size_t nguids = 0;
  while (sqlite3_step(st) == SQLITE_ROW) {
    buf b = {0};
    /* graves.oid's space is its row's type; a new note type's fields and templates mask their id. */
    int grave_sp = -1, mask = 0, new_note = 0;
    for (int c = 0; c < ncol; c++) {
      const char *name = sqlite3_column_name(st, c);
      if (!strcmp(table, "graves") && !strcmp(name, "type")) {
        int64_t t = sqlite3_column_int64(st, c);
        grave_sp = t == 0 ? SP_CARD : t == 1 ? SP_NOTE : SP_DECK;
      }
      if ((!strcmp(table, "fields") || !strcmp(table, "templates")) && !strcmp(name, "ntid") &&
          id_index(SP_NOTETYPE, sqlite3_column_int64(st, c)))
        mask = !strcmp(table, "fields") ? 9 : 8;
      if (!strcmp(table, "notes") && !strcmp(name, "id") && id_index(SP_NOTE, sqlite3_column_int64(st, c)))
        new_note = 1;
    }
    for (int c = 0; c < ncol; c++) {
      const char *name = sqlite3_column_name(st, c);
      bfmt(&b, "%s%s=", c ? " " : "", name);
      switch (sqlite3_column_type(st, c)) {
        case SQLITE_NULL: bstr(&b, "null"); break;
        case SQLITE_INTEGER: {
          int sp = !strcmp(table, "graves") && !strcmp(name, "oid") ? grave_sp : column_space(table, name);
          put_int(&b, sqlite3_column_int64(st, c), sp);
          break;
        }
        case SQLITE_FLOAT: bfmt(&b, "r%.17g", sqlite3_column_double(st, c)); break;
        case SQLITE_TEXT: {
          const unsigned char *s = sqlite3_column_text(st, c);
          size_t n = (size_t)sqlite3_column_bytes(st, c);
          if (new_note && !strcmp(name, "guid")) {
            for (size_t i = 0; i < n; i++)
              if (!strchr(BASE91, s[i])) {
                fprintf(stderr, "parity_dump: guid %s is not base91\n", s);
                failures++;
              }
            if (n == 0 || n > 10) {
              fprintf(stderr, "parity_dump: guid '%s' has the wrong length\n", s);
              failures++;
            }
            guids = xrealloc(guids, (nguids + 1) * sizeof *guids);
            guids[nguids++] = strdup((const char *)s);
            bstr(&b, "\"<G>\"");
            break;
          }
          /* The schema 11 JSON columns: a bare number is an id of the column's own kind. */
          int sp = -1;
          if (!strcmp(table, "col"))
            sp = !strcmp(name, "decks") ? SP_DECK : !strcmp(name, "models") ? SP_NOTETYPE : !strcmp(name, "dconf") ? SP_DCONF : -1;
          bstr(&b, "\"");
          put_text(&b, s, n, sp);
          bstr(&b, "\"");
          break;
        }
        case SQLITE_BLOB: {
          const unsigned char *p = sqlite3_column_blob(st, c);
          size_t n = (size_t)sqlite3_column_bytes(st, c);
          if (!strcmp(table, "config") && !strcmp(name, "val")) {
            bstr(&b, "json:");
            put_text(&b, p, n, -1);
          } else if (pb_valid(p, n)) {
            put_pb(&b, p, n, mask, 0);
          } else {
            bstr(&b, "0x");
            put_hex(&b, p, n);
          }
          break;
        }
      }
    }
    if (nrows == cap) {
      cap = cap ? cap * 2 : 64;
      rows = xrealloc(rows, cap * sizeof *rows);
    }
    rows[nrows++] = b.p ? b.p : strdup("");
  }
  sqlite3_finalize(st);
  qsort(rows, nrows, sizeof *rows, cmpstr);
  printf("table %s: %zu rows\n", table, nrows);
  for (size_t i = 0; i < nrows; i++) {
    printf("  %s\n", rows[i]);
    free(rows[i]);
  }
  free(rows);
  qsort(guids, nguids, sizeof *guids, cmpstr);
  for (size_t i = 1; i < nguids; i++)
    if (!strcmp(guids[i], guids[i - 1])) {
      fprintf(stderr, "parity_dump: guid %s is on two notes\n", guids[i]);
      failures++;
    }
  for (size_t i = 0; i < nguids; i++) free(guids[i]);
  free(guids);
}

static void dump_collection(const char *path) {
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) die("open %s: %s", path, sqlite3_errmsg(db));
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, NULL, unicase);
  sqlite3_stmt *st = prep("SELECT ver FROM col");
  if (sqlite3_step(st) != SQLITE_ROW) die("no col row in %s", path);
  schema_version = sqlite3_column_int(st, 0);
  sqlite3_finalize(st);
  for (int s = 0; s < SPACES; s++) spaces[s].n = 0;
  collect_ids();
  printf("schema %d\n", schema_version);
  for (int s = 0; s < SPACES; s++) printf("made during the run: %c x%zu\n", SP_LETTER[s], spaces[s].n);

  /* The schema text exactly: a collation relaxed for a write and not put back shows here. */
  st = prep("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
  char **tables = NULL;
  size_t ntables = 0;
  while (sqlite3_step(st) == SQLITE_ROW) {
    const char *type = (const char *)sqlite3_column_text(st, 0), *name = (const char *)sqlite3_column_text(st, 1);
    const char *sql = (const char *)sqlite3_column_text(st, 3);
    printf("%s %s on %s: %s\n", type, name, sqlite3_column_text(st, 2), sql ? sql : "(none)");
    if (!strcmp(type, "table") && strncmp(name, "sqlite_", 7)) {
      tables = xrealloc(tables, (ntables + 1) * sizeof *tables);
      tables[ntables++] = strdup(name);
    }
  }
  sqlite3_finalize(st);
  for (size_t i = 0; i < ntables; i++) {
    dump_table(tables[i]);
    free(tables[i]);
  }
  free(tables);
  st = prep("PRAGMA integrity_check");
  while (sqlite3_step(st) == SQLITE_ROW) printf("integrity: %s\n", sqlite3_column_text(st, 0));
  sqlite3_finalize(st);
  sqlite3_close(db);
}

/* FNV-1a 64: enough to tell two files' bytes apart in a test. */
static uint64_t fnv(const unsigned char *p, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}

static char **sorted_dir(const char *dir, size_t *count) {
  DIR *d = opendir(dir);
  *count = 0;
  if (!d) return NULL;
  char **names = NULL;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    names = xrealloc(names, (*count + 1) * sizeof *names);
    names[(*count)++] = strdup(e->d_name);
  }
  closedir(d);
  qsort(names, *count, sizeof *names, cmpstr);
  return names;
}

static void dump_media(const char *dir) {
  size_t n;
  char **names = sorted_dir(dir, &n);
  printf("media: %zu files\n", n);
  for (size_t i = 0; i < n; i++) {
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", dir, names[i]);
    FILE *f = fopen(path, "rb");
    if (!f) die("read %s", path);
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *p = xrealloc(NULL, (size_t)len);
    if (fread(p, 1, (size_t)len, f) != (size_t)len) die("read %s", path);
    fclose(f);
    printf("  %s %ld bytes %016" PRIx64 "\n", names[i], len, fnv(p, (size_t)len));
    free(p);
    free(names[i]);
  }
  free(names);
}

/* Backups: how many, and each one as a collection (its name has a time in it, so not the name). */
static void dump_backups(const char *dir) {
  size_t n;
  char **names = sorted_dir(dir, &n);
  printf("backups: %zu\n", n);
  for (size_t i = 0; i < n; i++) {
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", dir, names[i]);
    printf("backup %zu:\n", i + 1);
    dump_collection(path);
    free(names[i]);
  }
  free(names);
}

int main(int argc, char **argv) {
  int i = 1;
  for (; i + 1 < argc && !strncmp(argv[i], "--", 2); i += 2) {
    if (!strcmp(argv[i], "--since")) since_ms = strtoll(argv[i + 1], NULL, 10);
    else if (!strcmp(argv[i], "--until")) until_ms = strtoll(argv[i + 1], NULL, 10);
    else die("unknown option %s", argv[i]);
  }
  if (i >= argc || !since_ms || !until_ms) die("usage: parity_dump --since MS --until MS collection.anki2 [media] [backups]");
  dump_collection(argv[i]);
  if (i + 1 < argc) dump_media(argv[i + 1]);
  if (i + 2 < argc) dump_backups(argv[i + 2]);
  return failures ? 1 : 0;
}
