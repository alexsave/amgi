/* backup.js: a copy of the collection before this process changes it, taken when this process has
 * not backed up this path yet, when the file does not look the way we left it (somebody else
 * wrote to it), or when our last backup is older than BACKUP_MAX_AGE_MS. See that file's header for
 * the policy and the guarantee; this is the same ledger, per process, keyed by path.resolve, under
 * a lock of its own since the server's threads share it.
 *
 * What is not the JavaScript's (finding 4 of the PR #30 review): the copy is never torn, stale or
 * hidden. It is SQLite's backup API on the connection that probed, so the -wal's committed frames
 * are in it and it is the snapshot the decision read (and, on the writing connection, the one the
 * write builds on); it goes to a temporary name that is not a backup's, is synced, and is renamed
 * into place without replacing anything, so a process killed mid-copy leaves no file the listing
 * or prune counts; and the listing stats an entry whose d_type the file system did not fill in. A
 * collection that cannot be read is not copied at all, where the JavaScript copied the file. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "core.h"

#define BACKUP_DIRNAME "amgi-collection-backups"
#define BACKUP_MAX_AGE_MS (30 * 60 * 1000)
#define BACKUP_KEEP_COUNT 10

typedef struct ledger_entry {
  struct ledger_entry *next;
  char *key;
  int64_t backed_up_at;
  char *mark; /* NULL: unknown */
} ledger_entry;
static ledger_entry *ledger;
static pthread_mutex_t ledger_lock = PTHREAD_MUTEX_INITIALIZER;

static ledger_entry *ledger_find(str key) {
  for (ledger_entry *e = ledger; e; e = e->next)
    if (strlen(e->key) == key.n && !memcmp(e->key, key.p, key.n)) return e;
  return NULL;
}

static char *dup_or_null(str s, int known) {
  if (!known) return NULL;
  char *p = malloc(s.n + 1);
  if (!p) abort();
  memcpy(p, s.p, s.n);
  p[s.n] = 0;
  return p;
}

/* readCollectionMark on an open connection: "<inode>:<mod>:<scm>:<ver>", or unknown (a str with p
 * NULL). Any failure reads as unknown, as the JavaScript's catch-all does. */
typedef struct { str path; conn *k; str out; } mark_args;
static void mark_body(cx *c, void *arg) {
  mark_args *m = arg;
  sqlite3_stmt *st = q_prep(c, m->k, "SELECT mod, scm, ver FROM col WHERE id = 1");
  int row = q_step(c, m->k, st);
  int64_t mod = row ? sqlite3_column_int64(st, 0) : 0, scm = row ? sqlite3_column_int64(st, 1) : 0;
  int64_t ver = row ? sqlite3_column_int64(st, 2) : 0;
  q_done(st);
  struct stat sb;
  if (row && stat(str_z(c->a, m->path), &sb) == 0)
    m->out = str_c(ar_fmt(c->a, "%llu:%lld:%lld:%lld", (unsigned long long)sb.st_ino, (long long)mod, (long long)scm, (long long)ver));
}
static str mark_on(cx *c, str path, conn *k) {
  mark_args m = {path, k, {NULL, 0}};
  if (cx_try(c, mark_body, &m) < 0) return (str){NULL, 0};
  return m.out;
}

/* openCollection for a handle of our own: OPEN_*, a thrown open reading as OPEN_LOCKED's "cannot". */
typedef struct { str path; conn *k; int result; } open_own;
static void open_own_body(cx *c, void *arg) {
  open_own *o = arg;
  int schema;
  o->result = conn_open(c, o->path, o->k, &schema);
}
static int open_own_conn(cx *c, str path, conn *k) {
  open_own o = {path, k, OPEN_NOT_FOUND};
  if (cx_try(c, open_own_body, &o) < 0) return -1;
  return o.result;
}

static str read_mark(cx *c, str path, conn *open_conn) {
  if (open_conn) return mark_on(c, path, open_conn);
  conn own;
  if (open_own_conn(c, path, &own) != OPEN_OK) return (str){NULL, 0};
  str m = mark_on(c, path, &own);
  conn_close(&own);
  return m;
}

/* ---- the files ---- */
static str backup_dir_for(cx *c, str path) { return path_join(c->a, path_dirname(c->a, path), S(BACKUP_DIRNAME)); }

/* new Date(ms).toISOString() with ':' and '.' as '-'. */
static void stamp_of(int64_t ms, char out[32]) {
  time_t secs = (time_t)(ms / 1000);
  struct tm tm;
  gmtime_r(&secs, &tm);
  snprintf(out, 32, "%04d-%02d-%02dT%02d-%02d-%02d-%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour,
           tm.tm_min, tm.tm_sec, (int)(ms % 1000));
}

/* parseStamp: the ms a backup name's stamp encodes, or -1 when it is not one of ours (it must
 * round-trip, so 31 February is not a date). */
static int64_t parse_stamp(str s) {
  if (s.n != 24) return -1;
  int y, mo, d, h, mi, se, ms;
  char z;
  char tmp[32];
  memcpy(tmp, s.p, s.n);
  tmp[s.n] = 0;
  for (int i = 0; i < 24; i++) {
    int digit = tmp[i] >= '0' && tmp[i] <= '9';
    int want_digit = !(i == 4 || i == 7 || i == 10 || i == 13 || i == 16 || i == 19 || i == 23);
    if (digit != want_digit) return -1;
  }
  if (tmp[4] != '-' || tmp[7] != '-' || tmp[10] != 'T' || tmp[13] != '-' || tmp[16] != '-' || tmp[19] != '-' || tmp[23] != 'Z')
    return -1;
  if (sscanf(tmp, "%4d-%2d-%2dT%2d-%2d-%2d-%3d%c", &y, &mo, &d, &h, &mi, &se, &ms, &z) != 8) return -1;
  struct tm tm = {0};
  tm.tm_year = y - 1900, tm.tm_mon = mo - 1, tm.tm_mday = d, tm.tm_hour = h, tm.tm_min = mi, tm.tm_sec = se;
  time_t t = timegm(&tm);
  if (t == (time_t)-1 && !(y == 1969)) return -1;
  int64_t v = (int64_t)t * 1000 + ms;
  char back[32];
  stamp_of(v, back);
  if (memcmp(back, tmp, 24)) return -1;
  return v;
}

typedef struct { str name, path; int64_t taken; } backup_file;
static int newest_first(const void *x, const void *y) {
  const backup_file *a = x, *b = y;
  if (a->taken != b->taken) return a->taken < b->taken ? 1 : -1;
  return -js_locale_cmp(a->name, b->name);
}

/* The listing reads the folder through this, so a test can hand it the DT_UNKNOWN entries some
 * file systems give. */
#ifndef BACKUP_READDIR
#define BACKUP_READDIR readdir
#endif

/* A regular file, never a symlink or a folder: d_type when the file system fills it in, lstat
 * when it says DT_UNKNOWN (some network and FUSE file systems, and older XFS, always do). */
static int is_regular(DIR *d, const struct dirent *e) {
  if (e->d_type == DT_REG) return 1;
  if (e->d_type != DT_UNKNOWN) return 0;
  struct stat sb;
  return fstatat(dirfd(d), e->d_name, &sb, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(sb.st_mode);
}

/* The files in this collection's backup folder named "<lead><basename>.<stamp><tail>", newest
 * first. The backups: lead "", tail ".bak". The copies in progress: lead ".", tail ".bak.tmp". */
static backup_file *list_named(cx *c, str path, str lead, str tail, size_t *n) {
  *n = 0;
  str dir = backup_dir_for(c, path);
  str prefix = str_cat(c->a, str_cat(c->a, lead, path_basename(c->a, path)), S("."));
  DIR *d = opendir(str_z(c->a, dir));
  if (!d) return NULL;
  size_t cap = 16;
  backup_file *out = ar_alloc(c->a, cap * sizeof *out);
  struct dirent *e;
  while ((e = BACKUP_READDIR(d))) {
    str name = str_c(e->d_name);
    if (!str_starts(name, prefix) || name.n < prefix.n + tail.n || memcmp(name.p + name.n - tail.n, tail.p, tail.n)) continue;
    int64_t taken = parse_stamp(str_sub(name, prefix.n, name.n - tail.n));
    if (taken < 0 || !is_regular(d, e)) continue;
    if (*n == cap) {
      backup_file *more = ar_alloc(c->a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more;
      cap *= 2;
    }
    str copy = str_c(ar_dup(c->a, name.p, name.n));
    out[(*n)++] = (backup_file){copy, path_join(c->a, dir, copy), taken};
  }
  closedir(d);
  qsort(out, *n, sizeof *out, newest_first);
  return out;
}
static backup_file *list_backups(cx *c, str path, size_t *n) { return list_named(c, path, S(""), S(".bak"), n); }

/* All but the BACKUP_KEEP_COUNT newest backups go, and so does a copy in progress whose stamp is
 * older than BACKUP_MAX_AGE_MS: no copy takes that long, so its process died mid-copy. A copy in
 * progress is never a backup (its name is not one), so it never counts toward the ten. */
static void prune_backups(cx *c, str path, int64_t now) {
  size_t n;
  backup_file *b = list_backups(c, path, &n);
  for (size_t i = BACKUP_KEEP_COUNT; i < n; i++) unlink(str_z(c->a, b[i].path)); /* not ours to remove: left */
  b = list_named(c, path, S("."), S(".bak.tmp"), &n);
  for (size_t i = 0; i < n; i++)
    if (now - b[i].taken > BACKUP_MAX_AGE_MS) unlink(str_z(c->a, b[i].path));
}

static int mkdir_p(const char *path) {
  char tmp[4096];
  size_t n = strlen(path);
  if (n >= sizeof tmp) return -1;
  memcpy(tmp, path, n + 1);
  for (size_t i = 1; i <= n; i++) {
    if (tmp[i] == '/' || tmp[i] == 0) {
      char was = tmp[i];
      tmp[i] = 0;
      if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
      tmp[i] = was;
    }
  }
  return 0;
}

/* The points a test can stop the process at (backup_unit.c); nothing in a real build. */
enum { FAULT_COPYING = 1, FAULT_WRITTEN = 2 };
#ifndef BACKUP_FAULT
#define BACKUP_FAULT(stage) ((void)0)
#endif

/* To the drive, not its cache: on macOS fsync stops at the cache and F_FULLFSYNC goes on; a file
 * system without F_FULLFSYNC gets fsync. */
static int sync_path(const char *p) {
  int fd = open(p, O_RDONLY);
  if (fd < 0) return -1;
  int r = -1;
#ifdef F_FULLFSYNC
  r = fcntl(fd, F_FULLFSYNC);
#endif
  if (r != 0) r = fsync(fd);
  int e = errno;
  close(fd);
  errno = e;
  return r;
}

/* Rename that never replaces: 0, or -1 with errno (EEXIST when `to` is taken). renamex_np and
 * renameat2 refuse an existing name atomically; a file system that does not do the flag (ENOTSUP,
 * EINVAL) gets link and unlink, which refuse it just as atomically. */
static int rename_excl(const char *from, const char *to) {
  int r;
#if defined(__APPLE__)
  r = renamex_np(from, to, RENAME_EXCL);
#elif defined(__linux__)
  r = renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
#else
  r = -1;
  errno = ENOTSUP;
#endif
  if (r == 0 || (errno != ENOTSUP && errno != EINVAL && errno != ENOSYS)) return r;
  if (link(from, to) != 0) return -1;
  unlink(from);
  return 0;
}

/* SQLite's backup of src's "main" into the empty file tmp: the pages src sees, the -wal's committed
 * frames included, and when src is in a read transaction, that transaction's snapshot. NULL, or
 * why not. The destination needs no journal and no syncs of its own: it is a temporary name until
 * it is complete and synced. */
static const char *copy_snapshot(sqlite3 *src, const char *tmp) {
  sqlite3 *dst = NULL;
  int rc = sqlite3_open_v2(tmp, &dst, SQLITE_OPEN_READWRITE, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_exec(dst, "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF", NULL, NULL, NULL);
  if (rc == SQLITE_OK) {
    sqlite3_backup *b = sqlite3_backup_init(dst, "main", src, "main");
    if (!b) rc = sqlite3_errcode(dst);
    else {
      while ((rc = sqlite3_backup_step(b, 256)) == SQLITE_OK) BACKUP_FAULT(FAULT_COPYING);
      int fin = sqlite3_backup_finish(b);
      rc = rc == SQLITE_DONE ? fin : rc;
    }
  }
  if (sqlite3_close(dst) != SQLITE_OK && rc == SQLITE_OK) rc = SQLITE_ERROR;
  return rc == SQLITE_OK ? NULL : sqlite3_errstr(rc);
}

/* backupCollectionFile, safely: the copy goes to ".<name>.tmp" beside where it will live, is synced,
 * and only then renamed to the backup's name, never over another file, and the folder synced. A
 * copy that fails is unlinked; one whose process died is left under a name that is not a backup's,
 * so the listing never sees it and prune_backups clears it later. The name's stamp walks forward a
 * millisecond at a time until it is free, as before. */
static str take_backup(cx *c, str path, sqlite3 *src) {
  str dir = backup_dir_for(c, path);
  const char *dirz = str_z(c->a, dir);
  if (mkdir_p(dirz) != 0) cx_throw(c, NULL, 0, "%s: could not make %.*s", strerror(errno), (int)dir.n, dir.p);
  str base = path_basename(c->a, path);
  int64_t started = now_ms(), off = 0;
  char stamp[32];
  const char *tmp = NULL;
  for (; off < 1000 && !tmp; off++) {
    stamp_of(started + off, stamp);
    const char *t = ar_fmt(c->a, "%s/.%.*s.%s.bak.tmp", dirz, (int)base.n, base.p, stamp);
    int fd = open(t, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd >= 0) {
      close(fd);
      tmp = t;
    } else if (errno != EEXIST) {
      cx_throw(c, NULL, 0, "%s, open '%s'", strerror(errno), t);
    }
  }
  if (!tmp) cx_throw(c, NULL, 0, "could not find a free backup name for %.*s in %.*s", (int)path.n, path.p, (int)dir.n, dir.p);
  off--;
  const char *why = copy_snapshot(src, tmp);
  if (!why && sync_path(tmp) != 0) why = strerror(errno);
  if (why) {
    unlink(tmp);
    cx_throw(c, NULL, 0, "%s, backup '%.*s' -> '%s'", why, (int)path.n, path.p, tmp);
  }
  BACKUP_FAULT(FAULT_WRITTEN);
  const char *dst = NULL;
  for (; off < 1000 && !dst; off++) {
    stamp_of(started + off, stamp);
    const char *d = ar_fmt(c->a, "%s/%.*s.%s.bak", dirz, (int)base.n, base.p, stamp);
    if (rename_excl(tmp, d) == 0) dst = d;
    else if (errno != EEXIST) break;
  }
  if (!dst) {
    int e = errno;
    unlink(tmp);
    cx_throw(c, NULL, 0, "%s, rename '%s' into %.*s", off < 1000 ? strerror(e) : "no free backup name", tmp, (int)dir.n, dir.p);
  }
  if (sync_path(dirz) != 0) cx_throw(c, NULL, 0, "%s, sync %.*s", strerror(errno), (int)dir.n, dir.p);
  prune_backups(c, path, now_ms());
  return str_c(dst);
}

/* ---- the policy ---- */

typedef struct { str path; conn *k; str mark, key; int64_t now; str dst; int taken; } backup_run;
static void backup_body(cx *c, void *arg) {
  backup_run *r = arg;
  r->mark = mark_on(c, r->path, r->k);
  pthread_mutex_lock(&ledger_lock);
  ledger_entry *rec = ledger_find(r->key);
  /* A mark we could not read is a collection Anki has open, and there is a recent backup. */
  int skip = rec && r->now - rec->backed_up_at < BACKUP_MAX_AGE_MS &&
             (!r->mark.p || (rec->mark && strlen(rec->mark) == r->mark.n && !memcmp(rec->mark, r->mark.p, r->mark.n)));
  pthread_mutex_unlock(&ledger_lock);
  if (skip) return;
  if (sqlite3_txn_state(r->k->db, "main") == SQLITE_TXN_WRITE)
    cx_throw(c, NULL, 0, "the backup of %.*s must come before the write lock", (int)r->path.n, r->path.p);
  r->dst = take_backup(c, r->path, r->k->db);
  r->taken = 1;
}

/* ensureBackupBeforeChange on k, the connection about to write: the mark the decision reads and
 * the copy are one snapshot, and that is the snapshot the write builds on when the caller has k in
 * a transaction (BEGIN, not yet written): anyone who commits after it makes the write fail
 * (SQLITE_BUSY_SNAPSHOT), so no write lands on a state the backup missed. A k in autocommit gets a
 * transaction of its own around the probe and the copy. k NULL: a handle of its own, and a
 * collection it cannot open is not copied, since the copy would be torn (addMedia only: a write
 * cannot get here with an unreadable collection). The backup's path, or empty. */
str ensure_backup_on(cx *c, str path, conn *k) {
  backup_run r = {path, k, {NULL, 0}, path_resolve(c->a, path), now_ms(), {NULL, 0}, 0};
  conn own;
  if (!k) {
    int open = open_own_conn(c, path, &own);
    if (open != OPEN_OK) return (str){NULL, 0};
    r.k = &own;
  }
  int began = sqlite3_get_autocommit(r.k->db);
  if (began && sqlite3_exec(r.k->db, "BEGIN", NULL, NULL, NULL) != SQLITE_OK) {
    if (!k) conn_close(&own);
    cx_throw(c, NULL, 0, "%s", sqlite3_errmsg(r.k->db));
  }
  int failed = cx_try(c, backup_body, &r);
  if (began) sqlite3_exec(r.k->db, "ROLLBACK", NULL, NULL, NULL); /* it only read */
  if (!k) conn_close(&own);
  if (failed) cx_rethrow(c);
  if (!r.taken) return (str){NULL, 0};
  /* Record the mark as of the backup, not just the time: if the caller never gets as far as
   * writing, the next call still sees an unchanged collection and does not copy it again. */
  pthread_mutex_lock(&ledger_lock);
  ledger_entry *rec = ledger_find(r.key);
  if (!rec) {
    rec = calloc(1, sizeof *rec);
    if (!rec) abort();
    rec->key = dup_or_null(r.key, 1);
    rec->next = ledger;
    ledger = rec;
  }
  free(rec->mark);
  rec->backed_up_at = r.now;
  rec->mark = dup_or_null(r.mark, r.mark.p != NULL);
  pthread_mutex_unlock(&ledger_lock);
  return r.dst;
}

/* noteCollectionWritten: how the collection looks after our write, read on k (NULL: a handle of
 * its own, whose open folds the WAL into the file). Read first, whether or not there is a record,
 * as noteCollectionWritten's default parameter does. */
void note_written_on(cx *c, str path, conn *k) {
  str key = path_resolve(c->a, path);
  str mark = read_mark(c, path, k);
  pthread_mutex_lock(&ledger_lock);
  ledger_entry *rec = ledger_find(key);
  if (rec) {
    free(rec->mark);
    rec->mark = dup_or_null(mark, mark.p != NULL);
  }
  pthread_mutex_unlock(&ledger_lock);
}

