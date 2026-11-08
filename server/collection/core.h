/* The collection core's insides, shared by its files (collection.h is what callers see).
 *
 * The code is a port of plusaudio/lib/collection, line for line where it matters, so the
 * structure follows the JavaScript's: a function that fails "throws" (cx_throw, a longjmp to the
 * nearest cx_try), and a caller that wants to survive it catches it, exactly where the JavaScript
 * had a try. Every statement goes through q_*, which binds a number the way node:sqlite does (an
 * integral one as an integer, anything else as a real) and resets after every use, and every
 * statement a connection prepared is finalised when it closes, as DatabaseSync.close does. */
#ifndef AMGI_COL_CORE_H
#define AMGI_COL_CORE_H
#include <setjmp.h>
#include <sqlite3.h>

#include "../json/anki_json.h"
#include "collection.h"
#include "util.h"

typedef struct cx cx;
struct cx {
  arena *a;
  jmp_buf *jb;  /* the innermost cx_try */
  col_err err;  /* what was thrown */
};

/* Throw: kind is a collection state ("locked", ...) or NULL, status an HTTP status or 0. */
_Noreturn void cx_throw(cx *c, const char *kind, int status, const char *fmt, ...) __attribute__((format(printf, 4, 5)));
_Noreturn void cx_rethrow(cx *c);
/* Run fn(c, arg); 0 when it returned, -1 when it threw (c->err says what). */
int cx_try(cx *c, void (*fn)(cx *, void *), void *arg);

/* ---- the database: one connection, opened per unit of work as open.js does ---- */
typedef struct {
  sqlite3 *db;
  int schema;
  sqlite3_stmt **stmts;
  size_t nstmts, cap;
} conn;

enum { OPEN_OK, OPEN_NOT_FOUND, OPEN_LOCKED, OPEN_UNSUPPORTED };
/* openCollection: OPEN_* (and *schema), or throws a SQLite error that is not a lock. */
int conn_open(cx *c, str path, conn *out, int *schema);
void conn_close(conn *k);
void conn_exec(cx *c, conn *k, const char *sql);
sqlite3_stmt *q_prep(cx *c, conn *k, const char *sql);
void q_num(sqlite3_stmt *st, int i, double v);
void q_int(sqlite3_stmt *st, int i, int64_t v);
void q_text(sqlite3_stmt *st, int i, str s);
void q_blob(sqlite3_stmt *st, int i, const void *p, size_t n);
int q_step(cx *c, conn *k, sqlite3_stmt *st); /* 1 a row, 0 done; throws on an error (and resets) */
void q_run(cx *c, conn *k, sqlite3_stmt *st);  /* step to the end, reset */
void q_done(sqlite3_stmt *st);                 /* reset and clear bindings after reading */
str q_col_text(cx *c, sqlite3_stmt *st, int i);
str q_col_blob(cx *c, sqlite3_stmt *st, int i);
int64_t now_ms(void);

/* The unicase collation (the unicase crate Anki uses: full case folding, then code point order),
 * registered on every connection, so the name columns' indexes are read and written as Anki's own
 * are. (The JavaScript could not register a collation, so it rewrote the schema to COLLATE NOCASE
 * around every such statement; C never touches the schema: the PR #30 review, finding 1.) */
int unicase_cmp(void *ctx, int na, const void *a, int nb, const void *b);

/* backup.js */
str read_mark(cx *c, str path, conn *open_conn); /* empty str: unknown (null) */
str ensure_backup(cx *c, str path, str mark);   /* the backup's path, or empty */
void note_written(cx *c, str path);

/* ---- text (deck.js, cardText.ts, template.js) ---- */
str strip_html_preserving_media(cx *c, str html);
int64_t field_checksum(cx *c, str text);
str *anki_fields(cx *c, const str *fields, size_t n);
str join_fields(cx *c, const str *fields, size_t n);
str *split_fields(cx *c, str flds, size_t *n);
int looks_romanized(cx *c, str text, str language);
str render_audio_reference(cx *c, str filename);
/* templateRendersNonEmpty: would the question render anything, given the non-empty names. */
int template_renders_nonempty(cx *c, str question, const str *names, size_t n);
/* ordinalsForNewNote: the 0-based card ordinals a new note needs. */
size_t ordinals_for_new_note(cx *c, const col_notetype *nt, const str *fields, size_t nfields, size_t ntags, int64_t **out);

/* ---- protobuf (protobuf.js) ---- */
typedef struct { buf b; } pbw;
void pb_varint(buf *b, uint64_t v);
void pb_varint_field(buf *b, uint32_t field, uint64_t v);
void pb_bytes_field(buf *b, uint32_t field, const void *p, size_t n);
typedef struct { uint32_t number, wire; uint64_t value; const unsigned char *bytes; size_t len; } pb_field;
/* readFieldsLenient: the next field (1), the end (0); a varint field not in wanted is skipped
 * unread (wanted is a bit mask of field numbers below 64). Throws on a malformed message. */
int pb_next(cx *c, const unsigned char *p, size_t n, size_t *at, uint64_t wanted, pb_field *f);

/* ---- decks.js ---- */
str fold_key(cx *c, str name);
str *human_name_to_components(cx *c, str human, size_t *n);
typedef struct { int64_t id; str name; int filtered; } deck_row;
deck_row *list_decks_for_schema(cx *c, conn *k, size_t *n, aj **json_out);
double *deck_and_child_ids(cx *c, conn *k, double deck_id, size_t *n);

/* ---- notetypes.js ---- */
col_notetype *read_notetypes(cx *c, conn *k, size_t *n);
#endif
