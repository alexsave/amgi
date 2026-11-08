/* src/server/anki/directClient.js and plusaudio/lib/collection/index.js: one function per op, each
 * under its path's lock, each opening the collection for one unit of work, the writes behind the
 * backup policy. See collection.h. */
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#include "core.h"

/* Declared by the files that define them. */
void deck_create(cx *c, conn *k, str human, col_deck_made *out);
void deck_rename(cx *c, conn *k, double deck_id, str human, col_renamed *out);
void deck_summary(cx *c, conn *k, double deck_id, col_removal *out);
void deck_remove(cx *c, conn *k, double deck_id, col_removal *out);
void note_insert(cx *c, conn *k, const col_notetype *nts, size_t nnt, const col_new_note *note, col_added *out);
void note_update(cx *c, conn *k, double note_id, const str *given, size_t ngiven, int has_language, str language,
                 int has_lfi, double lfi, int *has_warning, str *warning);
void note_remove(cx *c, conn *k, double note_id, int64_t *out_id, int64_t *removed);
void notes_count(cx *c, conn *k, double deck, int64_t *out);
void notes_page(cx *c, conn *k, double deck, double offset, double limit, col_note **out, size_t *nout);
void field_values(cx *c, conn *k, double deck, double notetype, double field, str **out, size_t *nout);
void spec_validate(cx *c, const col_spec *spec);
void notetype_create(cx *c, conn *k, const col_spec *spec, col_notetype_made *out);
str media_dir_for(cx *c, str collection);
str media_add(cx *c, str dir, str desired, const void *data, size_t len);
int media_write_fixed(cx *c, str dir, str name, const void *data, size_t len);
int media_exists(cx *c, str dir, str name);
int media_read(cx *c, str dir, str name, str *out);

/* ---- the per-path lock: directClient's promise chain, one per path.resolve spelling ---- */
/* A ticket lock: callers are served in the order they asked, as the promise chain serves them, so a
 * write queued behind a long one is never overtaken by a later arrival.
 *
 * A ticket is always given back: the op runs inside cx_try (locked below), so a throw, which is a
 * longjmp out of the op, lands before lock_give. A thread is never cancelled while it holds one:
 * nothing in amgi's C or in cbase cancels a thread (test/parity/c-rules.test.mjs fails if one
 * appears), so no cancellation point can leave a ticket taken and its path stuck. */
typedef struct path_lock {
  struct path_lock *next;
  char *key;
  pthread_mutex_t m;
  pthread_cond_t turn;
  uint64_t next_ticket, serving;
} path_lock;
static path_lock *locks;
static pthread_mutex_t locks_lock = PTHREAD_MUTEX_INITIALIZER;

static path_lock *lock_for(arena *a, str path) {
  cx c = {a, NULL, {0}};
  str key = path_resolve(c.a, path);
  pthread_mutex_lock(&locks_lock);
  path_lock *l = locks;
  while (l && !(strlen(l->key) == key.n && !memcmp(l->key, key.p, key.n))) l = l->next;
  if (!l) {
    l = calloc(1, sizeof *l);
    if (!l) abort();
    l->key = malloc(key.n + 1);
    if (!l->key) abort();
    memcpy(l->key, key.p, key.n);
    l->key[key.n] = 0;
    pthread_mutex_init(&l->m, NULL);
    pthread_cond_init(&l->turn, NULL);
    l->next = locks;
    locks = l;
  }
  pthread_mutex_unlock(&locks_lock);
  return l;
}

static void lock_take(path_lock *l) {
  pthread_mutex_lock(&l->m);
  uint64_t mine = l->next_ticket++;
  while (l->serving != mine) pthread_cond_wait(&l->turn, &l->m);
  pthread_mutex_unlock(&l->m);
}

static void lock_give(path_lock *l) {
  pthread_mutex_lock(&l->m);
  l->serving++;
  pthread_cond_broadcast(&l->turn);
  pthread_mutex_unlock(&l->m);
}

/* Run fn under the path's lock, catching what it throws into *err. */
typedef struct { str path; void *arg; void (*fn)(cx *, str, void *); } locked_args;
static void locked_body(cx *c, void *arg) {
  locked_args *l = arg;
  l->fn(c, l->path, l->arg);
}
static int locked(arena *a, str path, void (*fn)(cx *, str, void *), void *arg, col_err *err) {
  path_lock *pl = lock_for(a, path);
  lock_take(pl);
  cx c = {a, NULL, {0}};
  locked_args l = {path, arg, fn};
  int r = cx_try(&c, locked_body, &l);
  lock_give(pl);
  if (r < 0 && err) *err = c.err;
  return r;
}

/* ---- withCollection and _withBackup ---- */
static const char *state_name(int open) {
  return open == OPEN_LOCKED ? "locked" : open == OPEN_NOT_FOUND ? "not-found" : "unsupported-schema";
}
static _Noreturn void not_ready(cx *c, int open) {
  const char *s = state_name(open);
  cx_throw(c, s, 0, "collection is %s", s);
}

typedef void (*conn_fn)(cx *, conn *, void *);
typedef struct { conn *k; conn_fn fn; void *arg; } with_args;
static void with_body(cx *c, void *arg) {
  with_args *w = arg;
  w->fn(c, w->k, w->arg);
}

/* withCollection: open, run, always close; a collection that will not open is unwrap's error. */
static void with_collection(cx *c, str path, conn_fn fn, void *arg) {
  conn k;
  int schema;
  int open = conn_open(c, path, &k, &schema);
  if (open != OPEN_OK) not_ready(c, open);
  k.schema = schema;
  with_args w = {&k, fn, arg};
  int failed = cx_try(c, with_body, &w);
  conn_close(&k);
  if (failed) cx_rethrow(c);
}

/* A write: withCollection, in one BEGIN IMMEDIATE ... COMMIT, rolled back on any error, so a note,
 * its cards, nextPos and col.mod land together or not at all (the PR #30 review, finding 3: the
 * JavaScript wrote them as separate autocommit statements). The one owner of a write transaction:
 * no body begins or commits its own. A collection Anki takes in the meantime is "locked", as the
 * statements would have been. */
typedef struct { conn *k; conn_fn fn; void *arg; } write_args;
static void write_body(cx *c, void *arg) {
  write_args *w = arg;
  conn_exec(c, w->k, "BEGIN IMMEDIATE");
  w->fn(c, w->k, w->arg);
  conn_exec(c, w->k, "COMMIT");
}
static void with_write(cx *c, str path, conn_fn fn, void *arg) {
  conn k;
  int schema;
  int open = conn_open(c, path, &k, &schema);
  if (open != OPEN_OK) not_ready(c, open);
  k.schema = schema;
  write_args w = {&k, fn, arg};
  int failed = cx_try(c, write_body, &w);
  if (failed) {
    col_err saved = c->err;
    /* A rollback that fails itself loses nothing: closing the connection rolls back too. */
    sqlite3_exec(k.db, "ROLLBACK", NULL, NULL, NULL);
    c->err = saved;
  }
  conn_close(&k);
  if (failed) cx_rethrow(c);
}

/* _withBackup: probe (a lock is returned as it is, never copied), back up if this change needs a
 * fresh copy, then the change, and the ledger told how the file looks after it whatever happened. */
typedef void (*path_fn)(cx *, str, void *);
typedef struct { str path; path_fn fn; void *arg; } backup_args;
static void backup_body(cx *c, void *arg) {
  backup_args *b = arg;
  b->fn(c, b->path, b->arg);
}
static void with_backup(cx *c, str path, path_fn fn, void *arg) {
  conn probe;
  int schema;
  int open = conn_open(c, path, &probe, &schema);
  if (open != OPEN_OK) not_ready(c, open);
  str mark = read_mark(c, path, &probe);
  conn_close(&probe);
  ensure_backup(c, path, mark);
  backup_args b = {path, fn, arg};
  int failed = cx_try(c, backup_body, &b);
  col_err saved = c->err;
  note_written(c, path);
  if (failed) {
    c->err = saved;
    cx_rethrow(c);
  }
}

/* ---- the ops ---- */
static void status_fn(cx *c, str path, void *arg) {
  col_state *out = arg;
  conn k;
  int schema = 0;
  int open = conn_open(c, path, &k, &schema);
  if (open == OPEN_OK) conn_close(&k);
  out->status = open == OPEN_OK ? "ok" : state_name(open);
  out->schema = open == OPEN_OK ? schema : 0;
}
int col_status(arena *a, str path, col_state *out, col_err *err) { return locked(a, path, status_fn, out, err); }

typedef struct { col_deck *decks; size_t n; } decks_out;
static void list_decks_conn(cx *c, conn *k, void *arg) {
  decks_out *o = arg;
  deck_row *rows = list_decks_for_schema(c, k, &o->n, NULL);
  o->decks = ar_alloc(c->a, (o->n + 1) * sizeof *o->decks);
  for (size_t i = 0; i < o->n; i++) o->decks[i] = (col_deck){rows[i].id, rows[i].name};
}
static void list_decks_fn(cx *c, str path, void *arg) { with_collection(c, path, list_decks_conn, arg); }
int col_list_decks(arena *a, str path, col_deck **out, size_t *n, col_err *err) {
  decks_out o = {0};
  int r = locked(a, path, list_decks_fn, &o, err);
  *out = o.decks, *n = o.n;
  return r;
}

typedef struct { col_notetype *nts; size_t n; } nts_out;
static void list_nts_conn(cx *c, conn *k, void *arg) {
  nts_out *o = arg;
  o->nts = read_notetypes(c, k, &o->n);
}
static void list_nts_fn(cx *c, str path, void *arg) { with_collection(c, path, list_nts_conn, arg); }
int col_list_notetypes(arena *a, str path, col_notetype **out, size_t *n, col_err *err) {
  nts_out o = {0};
  int r = locked(a, path, list_nts_fn, &o, err);
  *out = o.nts, *n = o.n;
  return r;
}

typedef struct { double deck, offset, limit; col_page *out; } page_args;
static void page_conn(cx *c, conn *k, void *arg) {
  page_args *p = arg;
  /* One row past the page, to know whether another exists. */
  notes_page(c, k, p->deck, p->offset, p->limit + 1, &p->out->notes, &p->out->n);
}
static void page_fn(cx *c, str path, void *arg) { with_collection(c, path, page_conn, arg); }
int col_list_notes(arena *a, str path, double deck, double offset, double limit, col_page *out, col_err *err) {
  memset(out, 0, sizeof *out);
  page_args p = {deck, offset, limit, out};
  int r = locked(a, path, page_fn, &p, err);
  if (r == 0) {
    out->has_more = (double)out->n > limit;
    /* notes.slice(0, limit): the limit as a whole number, from the end when negative. */
    double whole = isnan(limit) ? 0 : trunc(limit);
    double keep = whole < 0 ? (double)out->n + whole : whole;
    if (keep < 0) keep = 0;
    if (keep < (double)out->n) out->n = (size_t)keep;
    out->offset = offset;
    out->limit = limit;
  }
  return r;
}

typedef struct { double deck; int64_t *out; } count_args;
static void count_conn(cx *c, conn *k, void *arg) {
  count_args *a = arg;
  notes_count(c, k, a->deck, a->out);
}
static void count_fn(cx *c, str path, void *arg) { with_collection(c, path, count_conn, arg); }
int col_count_notes(arena *a, str path, double deck, int64_t *out, col_err *err) {
  count_args ca = {deck, out};
  return locked(a, path, count_fn, &ca, err);
}

typedef struct { double deck, nt, field; str *out; size_t n; } values_args;
static void values_conn(cx *c, conn *k, void *arg) {
  values_args *v = arg;
  field_values(c, k, v->deck, v->nt, v->field, &v->out, &v->n);
}
static void values_fn(cx *c, str path, void *arg) { with_collection(c, path, values_conn, arg); }
int col_field_values(arena *a, str path, double deck, double notetype, double field, str **out, size_t *n, col_err *err) {
  values_args v = {deck, notetype, field, NULL, 0};
  int r = locked(a, path, values_fn, &v, err);
  *out = v.out, *n = v.n;
  return r;
}

typedef struct { const col_spec *spec; const col_media *media; size_t nmedia; col_notetype_made *out; } nt_create_args;
static void nt_create_conn(cx *c, conn *k, void *arg) {
  nt_create_args *n = arg;
  notetype_create(c, k, n->spec, n->out);
}
static void nt_create_path(cx *c, str path, void *arg) {
  nt_create_args *n = arg;
  spec_validate(c, n->spec);
  with_write(c, path, nt_create_conn, arg);
  /* The note type's own media, after the rows, and only when it really was made. */
  if (n->out->created) {
    str dir = media_dir_for(c, path);
    for (size_t i = 0; i < n->nmedia; i++) media_write_fixed(c, dir, n->media[i].name, n->media[i].data, n->media[i].len);
  }
}
static void nt_create_fn(cx *c, str path, void *arg) { with_backup(c, path, nt_create_path, arg); }
int col_create_notetype(arena *a, str path, const col_spec *spec, const col_media *media, size_t nmedia,
                        col_notetype_made *out, col_err *err) {
  memset(out, 0, sizeof *out);
  nt_create_args n = {spec, media, nmedia, out};
  return locked(a, path, nt_create_fn, &n, err);
}

typedef struct { str name; col_deck_made *out; } create_args;
static void create_conn(cx *c, conn *k, void *arg) {
  create_args *cr = arg;
  deck_create(c, k, cr->name, cr->out);
}
static void create_path(cx *c, str path, void *arg) { with_write(c, path, create_conn, arg); }
static void create_fn(cx *c, str path, void *arg) { with_backup(c, path, create_path, arg); }
int col_create_deck(arena *a, str path, str name, col_deck_made *out, col_err *err) {
  memset(out, 0, sizeof *out);
  create_args cr = {name, out};
  return locked(a, path, create_fn, &cr, err);
}

static void touch(cx *c, conn *k) {
  sqlite3_stmt *st = q_prep(c, k, "UPDATE col SET mod = ? WHERE id = 1");
  q_int(st, 1, now_ms());
  q_run(c, k, st);
}

typedef struct { const col_new_note *notes; size_t n; col_added *out; int bulk; } add_args;
typedef struct { conn *k; col_notetype *nts; size_t nnt; const col_new_note *note; col_added *out; } one_args;
static void one_body(cx *c, void *arg) {
  one_args *o = arg;
  note_insert(c, o->k, o->nts, o->nnt, o->note, o->out);
}
static void add_conn(cx *c, conn *k, void *arg) {
  add_args *ad = arg;
  size_t nnt;
  col_notetype *nts = read_notetypes(c, k, &nnt);
  for (size_t i = 0; i < ad->n; i++) {
    memset(&ad->out[i], 0, sizeof ad->out[i]);
    if (!ad->bulk) {
      note_insert(c, k, nts, nnt, &ad->notes[i], &ad->out[i]);
      continue;
    }
    /* One bad note is reported in its own slot; the rest go on. Each note is its own savepoint, so
     * one that fails part way (its note in, a card refused) leaves nothing of itself. */
    one_args o = {k, nts, nnt, &ad->notes[i], &ad->out[i]};
    conn_exec(c, k, "SAVEPOINT amgi_note");
    if (cx_try(c, one_body, &o) < 0) {
      memset(&ad->out[i], 0, sizeof ad->out[i]);
      ad->out[i].error = c->err.message;
      conn_exec(c, k, "ROLLBACK TO amgi_note");
    }
    conn_exec(c, k, "RELEASE amgi_note");
  }
  touch(c, k);
}
static void add_path(cx *c, str path, void *arg) { with_write(c, path, add_conn, arg); }
static void add_fn(cx *c, str path, void *arg) { with_backup(c, path, add_path, arg); }
int col_add_note(arena *a, str path, const col_new_note *note, col_added *out, col_err *err) {
  add_args ad = {note, 1, out, 0};
  return locked(a, path, add_fn, &ad, err);
}
int col_add_notes(arena *a, str path, const col_new_note *notes, size_t n, col_added *out, col_err *err) {
  add_args ad = {notes, n, out, 1};
  return locked(a, path, add_fn, &ad, err);
}

typedef struct { double deck; str name; col_renamed *out; } rename_args2;
static void rename_conn(cx *c, conn *k, void *arg) {
  rename_args2 *r = arg;
  deck_rename(c, k, r->deck, r->name, r->out);
}
static void rename_path(cx *c, str path, void *arg) { with_write(c, path, rename_conn, arg); }
static void rename_fn(cx *c, str path, void *arg) { with_backup(c, path, rename_path, arg); }
int col_rename_deck(arena *a, str path, double deck, str name, col_renamed *out, col_err *err) {
  memset(out, 0, sizeof *out);
  rename_args2 r = {deck, name, out};
  return locked(a, path, rename_fn, &r, err);
}

typedef struct { double deck; col_removal *out; } removal_args;
static void summary_conn(cx *c, conn *k, void *arg) {
  removal_args *r = arg;
  deck_summary(c, k, r->deck, r->out);
}
static void summary_fn(cx *c, str path, void *arg) { with_collection(c, path, summary_conn, arg); }
int col_removal_summary(arena *a, str path, double deck, col_removal *out, col_err *err) {
  memset(out, 0, sizeof *out);
  removal_args r = {deck, out};
  return locked(a, path, summary_fn, &r, err);
}

static void remove_conn(cx *c, conn *k, void *arg) {
  removal_args *r = arg;
  deck_remove(c, k, r->deck, r->out);
}
static void remove_path(cx *c, str path, void *arg) {
  removal_args *r = arg;
  if (r->deck == 1) cx_throw(c, NULL, 400, "The Default deck cannot be deleted: Anki keeps it, and would only empty it.");
  with_write(c, path, remove_conn, arg);
}
static void remove_fn(cx *c, str path, void *arg) { with_backup(c, path, remove_path, arg); }
int col_remove_deck(arena *a, str path, double deck, col_removal *out, col_err *err) {
  memset(out, 0, sizeof *out);
  removal_args r = {deck, out};
  return locked(a, path, remove_fn, &r, err);
}

typedef struct { double note; int64_t *id, *removed; } rm_note_args;
static void rm_note_conn(cx *c, conn *k, void *arg) {
  rm_note_args *r = arg;
  note_remove(c, k, r->note, r->id, r->removed);
}
static void rm_note_path(cx *c, str path, void *arg) { with_write(c, path, rm_note_conn, arg); }
static void rm_note_fn(cx *c, str path, void *arg) { with_backup(c, path, rm_note_path, arg); }
int col_remove_note(arena *a, str path, double note, int64_t *note_id, int64_t *cards_removed, col_err *err) {
  rm_note_args r = {note, note_id, cards_removed};
  return locked(a, path, rm_note_fn, &r, err);
}

typedef struct {
  double note;
  const str *fields;
  size_t nfields;
  int has_language;
  str language;
  int has_lfi;
  double lfi;
  int *has_warning;
  str *warning;
} update_args;
static void update_conn(cx *c, conn *k, void *arg) {
  update_args *u = arg;
  note_update(c, k, u->note, u->fields, u->nfields, u->has_language, u->language, u->has_lfi, u->lfi, u->has_warning, u->warning);
}
static void update_path(cx *c, str path, void *arg) { with_write(c, path, update_conn, arg); }
static void update_fn(cx *c, str path, void *arg) { with_backup(c, path, update_path, arg); }
int col_update_note(arena *a, str path, double note, const str *fields, size_t nfields, int has_language, str language,
                    int has_learning_field, double learning_field, int *has_warning, str *warning, col_err *err) {
  *has_warning = 0;
  update_args u = {note, fields, nfields, has_language, language, has_learning_field, learning_field, has_warning, warning};
  return locked(a, path, update_fn, &u, err);
}

/* Media: a plain folder, not behind the collection's lock (but behind this process's path lock, as
 * directClient runs every op through the chain), and addMedia behind the backup policy. */
typedef struct { str name; int *out; } has_args;
static void has_fn(cx *c, str path, void *arg) {
  has_args *h = arg;
  *h->out = media_exists(c, media_dir_for(c, path), h->name);
}
int col_has_media(arena *a, str path, str name, int *out, col_err *err) {
  has_args h = {name, out};
  return locked(a, path, has_fn, &h, err);
}

typedef struct { str name; int *found; str *bytes; } read_args;
static void read_fn(cx *c, str path, void *arg) {
  read_args *r = arg;
  *r->found = media_read(c, media_dir_for(c, path), r->name, r->bytes);
}
int col_read_media(arena *a, str path, str name, int *found, str *bytes, col_err *err) {
  read_args r = {name, found, bytes};
  return locked(a, path, read_fn, &r, err);
}

typedef struct { str name; const void *data; size_t len; str *stored; } addm_args;
static void addm_fn(cx *c, str path, void *arg) {
  addm_args *m = arg;
  ensure_backup(c, path, read_mark(c, path, NULL));
  *m->stored = media_add(c, media_dir_for(c, path), m->name, m->data, m->len);
}
int col_add_media(arena *a, str path, str name, const void *data, size_t len, str *stored, col_err *err) {
  addm_args m = {name, data, len, stored};
  return locked(a, path, addm_fn, &m, err);
}
