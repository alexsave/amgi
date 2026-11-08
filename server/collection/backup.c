/* backup.js: a copy of the collection before this process changes it, taken when this process has
 * not backed up this path yet, when the file does not look the way we left it (somebody else
 * wrote to it), or when our last backup is older than BACKUP_MAX_AGE_MS. See that file's header for
 * the policy and the guarantee; this is the same ledger, per process, keyed by path.resolve, under
 * a lock of its own since the server's threads share it. */
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

/* readCollectionMark: "<inode>:<mod>:<scm>:<ver>", or unknown (a str with p NULL). Any failure
 * reads as unknown, as the JavaScript's catch-all does. */
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

typedef struct { str path; conn *k; int result; } open_for_mark;
static void open_mark_body(cx *c, void *arg) {
  open_for_mark *o = arg;
  int schema;
  o->result = conn_open(c, o->path, o->k, &schema);
}

str read_mark(cx *c, str path, conn *open_conn) {
  mark_args m = {path, open_conn, {NULL, 0}};
  if (open_conn) {
    if (cx_try(c, mark_body, &m) < 0) return (str){NULL, 0};
    return m.out;
  }
  conn own;
  open_for_mark o = {path, &own, OPEN_NOT_FOUND};
  if (cx_try(c, open_mark_body, &o) < 0 || o.result != OPEN_OK) return (str){NULL, 0};
  m.k = &own;
  int failed = cx_try(c, mark_body, &m);
  conn_close(&own);
  return failed ? (str){NULL, 0} : m.out;
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

static backup_file *list_backups(cx *c, str path, size_t *n) {
  *n = 0;
  str dir = backup_dir_for(c, path);
  str prefix = str_cat(c->a, path_basename(c->a, path), S("."));
  DIR *d = opendir(str_z(c->a, dir));
  if (!d) return NULL;
  size_t cap = 16;
  backup_file *out = ar_alloc(c->a, cap * sizeof *out);
  struct dirent *e;
  while ((e = readdir(d))) {
    if (e->d_type != DT_REG) continue;
    str name = str_c(e->d_name);
    if (!str_starts(name, prefix) || name.n < prefix.n + 4 || memcmp(name.p + name.n - 4, ".bak", 4)) continue;
    int64_t taken = parse_stamp(str_sub(name, prefix.n, name.n - 4));
    if (taken < 0) continue;
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

static void prune_backups(cx *c, str path) {
  size_t n;
  backup_file *b = list_backups(c, path, &n);
  for (size_t i = BACKUP_KEEP_COUNT; i < n; i++) unlink(str_z(c->a, b[i].path)); /* not ours to remove: left */
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

/* fs.copyFileSync(src, dst, COPYFILE_EXCL): -1 with errno EEXIST when the name is taken. */
static int copy_excl(const char *src, const char *dst) {
  int in = open(src, O_RDONLY);
  if (in < 0) return -1;
  int out = open(dst, O_WRONLY | O_CREAT | O_EXCL, 0644);
  if (out < 0) {
    int e = errno;
    close(in);
    errno = e;
    return -1;
  }
  char chunk[1 << 16];
  ssize_t r;
  int ok = 0;
  while ((r = read(in, chunk, sizeof chunk)) > 0)
    if (write(out, chunk, (size_t)r) != r) {
      ok = -1;
      break;
    }
  if (r < 0) ok = -1;
  int e = errno;
  close(in);
  close(out);
  errno = e;
  return ok;
}

static str backup_collection_file(cx *c, str path) {
  str dir = backup_dir_for(c, path);
  if (mkdir_p(str_z(c->a, dir)) != 0) cx_throw(c, NULL, 0, "%s: could not make %.*s", strerror(errno), (int)dir.n, dir.p);
  str base = path_basename(c->a, path);
  int64_t started = now_ms();
  for (int64_t off = 0; off < 1000; off++) {
    char stamp[32];
    stamp_of(started + off, stamp);
    str dst = path_join(c->a, dir, str_c(ar_fmt(c->a, "%.*s.%s.bak", (int)base.n, base.p, stamp)));
    if (copy_excl(str_z(c->a, path), str_z(c->a, dst)) != 0) {
      if (errno == EEXIST) continue;
      cx_throw(c, NULL, 0, "%s, copyfile '%.*s' -> '%.*s'", strerror(errno), (int)path.n, path.p, (int)dst.n, dst.p);
    }
    prune_backups(c, path);
    return dst;
  }
  cx_throw(c, NULL, 0, "could not find a free backup name for %.*s in %.*s", (int)path.n, path.p, (int)dir.n, dir.p);
}

str ensure_backup(cx *c, str path, str mark) {
  str key = path_resolve(c->a, path);
  int64_t now = now_ms();
  pthread_mutex_lock(&ledger_lock);
  ledger_entry *rec = ledger_find(key);
  if (rec && now - rec->backed_up_at < BACKUP_MAX_AGE_MS) {
    /* An unreadable collection is one Anki has open: copying it would be torn, and there is a
     * recent backup. Only addMedia gets here in that state. */
    int same = mark.p && rec->mark && strlen(rec->mark) == mark.n && !memcmp(rec->mark, mark.p, mark.n);
    if (!mark.p || same) {
      pthread_mutex_unlock(&ledger_lock);
      return (str){NULL, 0};
    }
  }
  pthread_mutex_unlock(&ledger_lock);
  str dst = backup_collection_file(c, path);
  pthread_mutex_lock(&ledger_lock);
  rec = ledger_find(key);
  if (!rec) {
    rec = calloc(1, sizeof *rec);
    if (!rec) abort();
    rec->key = dup_or_null(key, 1);
    rec->next = ledger;
    ledger = rec;
  }
  free(rec->mark);
  rec->backed_up_at = now;
  rec->mark = dup_or_null(mark, mark.p != NULL);
  pthread_mutex_unlock(&ledger_lock);
  return dst;
}

void note_written(cx *c, str path) {
  str key = path_resolve(c->a, path);
  /* Read first, whether or not there is a record: noteCollectionWritten's default parameter does,
   * and the open it takes folds the WAL into the file. */
  str mark = read_mark(c, path, NULL);
  pthread_mutex_lock(&ledger_lock);
  ledger_entry *rec = ledger_find(key);
  if (rec) {
    free(rec->mark);
    rec->mark = dup_or_null(mark, mark.p != NULL);
  }
  pthread_mutex_unlock(&ledger_lock);
}
