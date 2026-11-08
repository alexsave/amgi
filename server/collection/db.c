/* open.js and relaxed-read.js, and the plumbing every other file stands on: see core.h. */
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unicode/unorm2.h>
#include <unicode/ustring.h>

#include "core.h"

/* ---- throwing ---- */
void cx_throw(cx *c, const char *kind, int status, const char *fmt, ...) {
  va_list ap, ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  char *p = ar_alloc(c->a, (size_t)n + 1);
  vsnprintf(p, (size_t)n + 1, fmt, ap2);
  va_end(ap2);
  c->err = (col_err){kind, status, {p, (size_t)n}};
  longjmp(*c->jb, 1);
}

void cx_rethrow(cx *c) { longjmp(*c->jb, 1); }

int cx_try(cx *c, void (*fn)(cx *, void *), void *arg) {
  jmp_buf jb, *outer = c->jb;
  c->jb = &jb;
  if (setjmp(jb)) {
    c->jb = outer;
    return -1;
  }
  fn(c, arg);
  c->jb = outer;
  return 0;
}

int64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* ---- statements ---- */
static _Noreturn void sql_throw(cx *c, conn *k) {
  const char *msg = sqlite3_errmsg(k->db);
  /* open.js's isLockedError: the message, as node:sqlite passes it on. */
  cx_throw(c, strcasestr(msg, "database is locked") ? "locked" : NULL, 0, "%s", msg);
}

sqlite3_stmt *q_prep(cx *c, conn *k, const char *sql) {
  sqlite3_stmt *st;
  if (sqlite3_prepare_v2(k->db, sql, -1, &st, NULL) != SQLITE_OK) sql_throw(c, k);
  if (k->nstmts == k->cap) {
    k->cap = k->cap ? k->cap * 2 : 32;
    sqlite3_stmt **s = realloc(k->stmts, k->cap * sizeof *s);
    if (!s) abort();
    k->stmts = s;
  }
  k->stmts[k->nstmts++] = st;
  return st;
}

/* node:sqlite binds a JS number that is a whole number as an integer, anything else as a real
 * (NaN as a real, which SQLite stores as NULL). */
void q_num(sqlite3_stmt *st, int i, double v) {
  if (isfinite(v) && v == trunc(v) && fabs(v) < 9.2e18) sqlite3_bind_int64(st, i, (sqlite3_int64)v);
  else sqlite3_bind_double(st, i, v);
}
void q_int(sqlite3_stmt *st, int i, int64_t v) { sqlite3_bind_int64(st, i, v); }
void q_text(sqlite3_stmt *st, int i, str s) { sqlite3_bind_text(st, i, s.n ? s.p : "", (int)s.n, SQLITE_TRANSIENT); }
void q_blob(sqlite3_stmt *st, int i, const void *p, size_t n) { sqlite3_bind_blob(st, i, n ? p : "", (int)n, SQLITE_TRANSIENT); }

int q_step(cx *c, conn *k, sqlite3_stmt *st) {
  int rc = sqlite3_step(st);
  if (rc == SQLITE_ROW) return 1;
  if (rc == SQLITE_DONE) return 0;
  sqlite3_reset(st);
  sql_throw(c, k);
}
void q_done(sqlite3_stmt *st) {
  sqlite3_reset(st);
  sqlite3_clear_bindings(st);
}
void q_run(cx *c, conn *k, sqlite3_stmt *st) {
  while (q_step(c, k, st)) {
  }
  q_done(st);
}
/* Text as node:sqlite reads it: a JS string decoded from the bytes, invalid sequences replaced. */
str q_col_text(cx *c, sqlite3_stmt *st, int i) {
  const unsigned char *p = sqlite3_column_text(st, i);
  size_t n = (size_t)sqlite3_column_bytes(st, i);
  return utf8_clean(c->a, (str){ar_dup(c->a, p ? (const char *)p : "", n), n});
}
str q_col_blob(cx *c, sqlite3_stmt *st, int i) {
  const void *p = sqlite3_column_blob(st, i);
  size_t n = (size_t)sqlite3_column_bytes(st, i);
  return (str){ar_dup(c->a, p ? p : "", n), n};
}

void conn_exec(cx *c, conn *k, const char *sql) {
  char *errmsg = NULL;
  if (sqlite3_exec(k->db, sql, NULL, NULL, &errmsg) != SQLITE_OK) {
    sqlite3_free(errmsg);
    sql_throw(c, k);
  }
}

void conn_close(conn *k) {
  for (size_t i = 0; i < k->nstmts; i++) sqlite3_finalize(k->stmts[i]);
  free(k->stmts);
  k->stmts = NULL;
  k->nstmts = k->cap = 0;
  if (k->db) sqlite3_close(k->db);
  k->db = NULL;
}

/* ---- unicase: the unicase crate's order, full case folding then code point order ---- */
int unicase_cmp(void *ctx, int na, const void *a, int nb, const void *b) {
  (void)ctx;
  arena ar = {0};
  uint32_t *fa, *fb;
  size_t la = unicase_fold32(&ar, (str){a, (size_t)na}, &fa), lb = unicase_fold32(&ar, (str){b, (size_t)nb}, &fb);
  int r = 0;
  for (size_t i = 0; i < la && i < lb && !r; i++) r = fa[i] < fb[i] ? -1 : fa[i] > fb[i];
  if (!r) r = la < lb ? -1 : la > lb;
  ar_free(&ar);
  return r;
}

/* ---- openCollection ---- */
static int file_exists(str path, arena *a) {
  struct stat sb;
  return stat(str_z(a, path), &sb) == 0;
}

/* A thrown SQLite error during the open: a lock is a state, anything else is thrown on. */
typedef struct { conn *k; int *schema; int result; } open_args;

static void open_body(cx *c, void *arg) {
  open_args *o = arg;
  conn *k = o->k;
  /* PRAGMA busy_timeout = 0: fail at once, as Anki's own connection does. */
  conn_exec(c, k, "PRAGMA busy_timeout = 0");
  sqlite3_stmt *st = q_prep(c, k, "SELECT ver FROM col");
  if (!q_step(c, k, st)) {
    q_done(st);
    cx_throw(c, NULL, 0, "Cannot read properties of undefined (reading 'ver')");
  }
  int64_t ver = sqlite3_column_int64(st, 0);
  q_done(st);
  if (ver != 11 && ver != 18) {
    *o->schema = (int)ver;
    o->result = OPEN_UNSUPPORTED;
    return;
  }
  *o->schema = (int)ver;
  conn_exec(c, k, "PRAGMA wal_checkpoint(TRUNCATE)");
  o->result = OPEN_OK;
}

int conn_open(cx *c, str path, conn *out, int *schema) {
  memset(out, 0, sizeof *out);
  if (!file_exists(path, c->a)) return OPEN_NOT_FOUND;
  if (sqlite3_open_v2(str_z(c->a, path), &out->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL) != SQLITE_OK) {
    const char *msg = out->db ? sqlite3_errmsg(out->db) : "out of memory";
    char *copy = ar_dup(c->a, msg, strlen(msg));
    conn_close(out);
    if (strcasestr(copy, "database is locked")) return OPEN_LOCKED;
    cx_throw(c, NULL, 0, "%s", copy);
  }
  /* What DatabaseSync sets up by default: defensive on, foreign keys on, no double-quoted strings. */
  sqlite3_db_config(out->db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  sqlite3_db_config(out->db, SQLITE_DBCONFIG_ENABLE_FKEY, 1, NULL);
  sqlite3_db_config(out->db, SQLITE_DBCONFIG_DQS_DML, 0, NULL);
  sqlite3_db_config(out->db, SQLITE_DBCONFIG_DQS_DDL, 0, NULL);
  sqlite3_create_collation(out->db, "unicase", SQLITE_UTF8, NULL, unicase_cmp);
  open_args o = {out, schema, OPEN_OK};
  if (cx_try(c, open_body, &o) < 0) {
    conn_close(out);
    if (c->err.kind && !strcmp(c->err.kind, "locked")) return OPEN_LOCKED;
    cx_rethrow(c);
  }
  if (o.result != OPEN_OK) conn_close(out);
  return o.result;
}
