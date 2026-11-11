/* Tests of the collection backup (collection/backup.c) by itself, on copies of the parity fixtures:
 * that a backup is never torn, stale or hidden (finding 4 of the PR #30 review). backup.c is
 * included, not linked, so these can stop the process at its fault points and hand its listing the
 * DT_UNKNOWN entries some file systems give. Run by `make -C server check-collection`, under ASan
 * and UBSan. With ANKI_PYTHON_BIN set, a backup is also opened in real Anki and checked.
 *
 *   build/backup_unit <repo root> */
#include <dirent.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* The fault points: the child of a crash test dies at the one it names. */
static int die_at;
#define BACKUP_FAULT(stage) ((stage) == die_at ? _exit(77) : (void)0)

/* The listing's readdir: with unknown_types set, every entry says DT_UNKNOWN. */
static int unknown_types;
static struct dirent *test_readdir(DIR *d) {
  struct dirent *e = readdir(d);
  if (e && unknown_types) e->d_type = DT_UNKNOWN;
  return e;
}
#define BACKUP_READDIR test_readdir

#include "../collection/backup.c"

static int failures, checks;
#define CHECK(cond, ...)                                    \
  do {                                                      \
    checks++;                                               \
    if (!(cond)) {                                          \
      failures++;                                           \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__);  \
      fprintf(stderr, __VA_ARGS__);                         \
      fputc('\n', stderr);                                  \
    }                                                       \
  } while (0)

/* ensure_backup_on under cx_try: 0, or -1 when it threw (c->err says what). */
typedef struct { str path; conn *k; str dst; } ensure_args;
static void ensure_body(cx *c, void *arg) {
  ensure_args *e = arg;
  e->dst = ensure_backup_on(c, e->path, e->k);
}
static int try_ensure(cx *c, str path, conn *k, str *dst) {
  ensure_args e = {path, k, {NULL, 0}};
  int r = cx_try(c, ensure_body, &e);
  *dst = e.dst;
  return r;
}

static const char *root;
static char scratch[4096];

static void die(const char *what) {
  perror(what);
  exit(2);
}

static void copy_file(const char *from, const char *to) {
  FILE *in = fopen(from, "rb"), *out = fopen(to, "wb");
  if (!in || !out) die(from);
  char chunk[1 << 16];
  size_t n;
  while ((n = fread(chunk, 1, sizeof chunk, in)) > 0) fwrite(chunk, 1, n, out);
  fclose(in);
  fclose(out);
}

/* A fresh copy of a fixture as <scratch>/<name>/collection.anki2. */
static str fixture(arena *a, const char *schema, const char *name) {
  char dir[4096], from[4096], to[4096];
  snprintf(dir, sizeof dir, "%s/%s", scratch, name);
  mkdir(dir, 0777);
  snprintf(from, sizeof from, "%s/tests/server/parity/fixtures/schema%s/collection.anki2", root, schema);
  snprintf(to, sizeof to, "%s/collection.anki2", dir);
  copy_file(from, to);
  return str_c(ar_dup(a, to, strlen(to)));
}

static const char *backups_dir(arena *a, str path) { return str_z(a, backup_dir_for(&(cx){a, NULL, {0}}, path)); }

/* A file in the backup folder under a backup's name, its stamp `ms`. */
static void plant(arena *a, str path, int64_t ms, const char *contents) {
  const char *dir = backups_dir(a, path);
  mkdir(dir, 0777);
  char stamp[32], name[4096];
  stamp_of(ms, stamp);
  snprintf(name, sizeof name, "%s/collection.anki2.%s.bak", dir, stamp);
  FILE *f = fopen(name, "wb");
  if (!f) die(name);
  fputs(contents, f);
  fclose(f);
}

/* What the folder holds: every name, sorted, one per line ("." and ".." left out). */
static char *folder(arena *a, str path) {
  DIR *d = opendir(backups_dir(a, path));
  char *names[256];
  size_t n = 0;
  struct dirent *e;
  while (d && (e = readdir(d)) && n < 256)
    if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) names[n++] = ar_fmt(a, "%s", e->d_name);
  if (d) closedir(d);
  for (size_t i = 0; i < n; i++)
    for (size_t j = i + 1; j < n; j++)
      if (strcmp(names[j], names[i]) < 0) {
        char *t = names[i];
        names[i] = names[j];
        names[j] = t;
      }
  char *out = ar_fmt(a, "%s", "");
  for (size_t i = 0; i < n; i++) out = ar_fmt(a, "%s%s\n", out, names[i]);
  return out;
}

/* Names in the folder that a backup could be mistaken for: not hidden, ending ".bak". */
static size_t bak_names(arena *a, str path) {
  DIR *d = opendir(backups_dir(a, path));
  size_t n = 0;
  struct dirent *e;
  while (d && (e = readdir(d))) {
    size_t len = strlen(e->d_name);
    if (e->d_name[0] != '.' && len > 4 && !strcmp(e->d_name + len - 4, ".bak")) n++;
  }
  if (d) closedir(d);
  return n;
}
static size_t tmp_names(arena *a, str path) {
  DIR *d = opendir(backups_dir(a, path));
  size_t n = 0;
  struct dirent *e;
  while (d && (e = readdir(d))) {
    size_t len = strlen(e->d_name);
    if (len > 8 && !strcmp(e->d_name + len - 8, ".bak.tmp")) n++;
  }
  if (d) closedir(d);
  return n;
}

static sqlite3 *raw_open(const char *path) {
  sqlite3 *db;
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) die(path);
  return db;
}
static void exec(sqlite3 *db, const char *sql) {
  char *err = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
    fprintf(stderr, "%s: %s\n", sql, err);
    exit(2);
  }
}
static int64_t scalar(sqlite3 *db, const char *sql) {
  sqlite3_stmt *st;
  int64_t v = -1;
  if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK && sqlite3_step(st) == SQLITE_ROW) v = sqlite3_column_int64(st, 0);
  sqlite3_finalize(st);
  return v;
}
static int64_t scalar_in(const char *file, const char *sql) {
  sqlite3 *db;
  if (sqlite3_open_v2(file, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) return -1;
  int64_t v = scalar(db, sql);
  sqlite3_close(db);
  return v;
}

/* Back up `path` in a child that dies at fault point `stage`; 1 when it died there. */
static int crash_backup(str path, int stage) {
  fflush(NULL);
  pid_t pid = fork();
  if (pid < 0) die("fork");
  if (pid == 0) {
    arena a = {0};
    cx c = {&a, NULL, {0}};
    die_at = stage;
    conn k = {0};
    k.db = raw_open(path.p);
    ensure_backup_on(&c, path, &k);
    _exit(0);
  }
  int status;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) && WEXITSTATUS(status) == 77;
}

/* Bigger than one backup step (256 pages), so a copy can be stopped halfway. */
static void make_big(str path) {
  sqlite3 *db = raw_open(path.p);
  exec(db, "CREATE TABLE filler (b BLOB); INSERT INTO filler VALUES (zeroblob(3 << 20))");
  sqlite3_close(db);
}

/* A process killed mid-copy, or between the synced copy and its rename, leaves no file under a
 * backup's name; prune never counts what it left; the backups already there are untouched; and the
 * next backup is whole, prunes exactly one old backup, and in time clears the leftover. */
static void killed_backups(void) {
  arena a = {0};
  cx c = {&a, NULL, {0}};
  str path = fixture(&a, "18", "killed");
  make_big(path);
  /* Ten backups already, the oldest first: Jan 1 2026 plus i minutes. */
  int64_t jan1 = 1767225600000;
  for (int i = 0; i < 10; i++) plant(&a, path, jan1 + i * 60000, ar_fmt(&a, "old backup %d", i));

  CHECK(crash_backup(path, FAULT_COPYING), "the child died mid-copy");
  CHECK(bak_names(&a, path) == 10, "killed mid-copy: no new file under a backup's name (%zu)", bak_names(&a, path));
  CHECK(tmp_names(&a, path) == 1, "and its partial copy is under the temporary name (%zu)", tmp_names(&a, path));

  CHECK(crash_backup(path, FAULT_WRITTEN), "the child died between the write and the rename");
  CHECK(bak_names(&a, path) == 10, "killed before the rename: no new file under a backup's name (%zu)", bak_names(&a, path));
  CHECK(tmp_names(&a, path) == 2, "and its copy is under the temporary name (%zu)", tmp_names(&a, path));
  size_t n;
  list_backups(&c, path, &n);
  CHECK(n == 10, "the listing counts the ten backups and nothing the dead copies left (%zu)", n);

  /* The old backups are byte for byte what they were. */
  for (int i = 0; i < 10; i++) {
    char stamp[32], name[4096], got[64] = {0};
    stamp_of(jan1 + i * 60000, stamp);
    snprintf(name, sizeof name, "%s/collection.anki2.%s.bak", backups_dir(&a, path), stamp);
    FILE *f = fopen(name, "rb");
    if (f) {
      if (!fgets(got, sizeof got, f)) got[0] = 0;
      fclose(f);
    }
    CHECK(!strcmp(got, ar_fmt(&a, "old backup %d", i)), "old backup %d intact (\"%s\")", i, got);
  }

  /* A whole backup now: ten kept, the oldest one pruned, nothing more; the fresh leftovers stay
   * (their copies might still be running in another process). */
  conn k = {0};
  k.db = raw_open(path.p);
  str dst = ensure_backup_on(&c, path, &k);
  conn_close(&k);
  CHECK(dst.p != NULL, "a backup was taken");
  CHECK(bak_names(&a, path) == 10, "ten backups kept (%zu)", bak_names(&a, path));
  char stamp[32];
  stamp_of(jan1, stamp);
  CHECK(!strstr(folder(&a, path), stamp), "the oldest was pruned, and only it");
  stamp_of(jan1 + 60000, stamp);
  CHECK(strstr(folder(&a, path), stamp) != NULL, "the second oldest is kept");
  CHECK(tmp_names(&a, path) == 2, "fresh leftovers are left (%zu)", tmp_names(&a, path));
  CHECK(dst.p && scalar_in(dst.p, "SELECT length(b) FROM filler") == (3 << 20), "the new backup is whole");

  /* A leftover older than BACKUP_MAX_AGE_MS is cleared by the next backup's prune. */
  char old_tmp[4096];
  stamp_of(jan1, stamp);
  snprintf(old_tmp, sizeof old_tmp, "%s/.collection.anki2.%s.bak.tmp", backups_dir(&a, path), stamp);
  FILE *f = fopen(old_tmp, "wb");
  if (f) fclose(f);
  prune_backups(&c, path, now_ms());
  CHECK(access(old_tmp, F_OK) != 0, "a stale leftover is removed");
  CHECK(tmp_names(&a, path) == 2, "the fresh ones are not (%zu)", tmp_names(&a, path));
  ar_free(&a);
}

/* Committed changes still in the -wal are in the backup. */
static void wal_covered(void) {
  arena a = {0};
  cx c = {&a, NULL, {0}};
  str path = fixture(&a, "18", "wal");
  sqlite3 *writer = raw_open(path.p);
  exec(writer, "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  exec(writer, "UPDATE col SET mod = 4242424242424");
  struct stat sb;
  char wal[4096];
  snprintf(wal, sizeof wal, "%s-wal", path.p);
  CHECK(stat(wal, &sb) == 0 && sb.st_size > 0, "the change is in the -wal");
  conn k = {0};
  k.db = raw_open(path.p); /* not conn_open, whose checkpoint would fold the -wal in first */
  str dst = ensure_backup_on(&c, path, &k);
  conn_close(&k);
  CHECK(dst.p && scalar_in(dst.p, "SELECT mod FROM col") == 4242424242424, "the backup has the -wal's change (%lld)",
        dst.p ? (long long)scalar_in(dst.p, "SELECT mod FROM col") : -1LL);
  sqlite3_close(writer);
  ar_free(&a);
}

/* The probe and the copy are the writing connection's snapshot: a commit somebody else makes
 * after the writer's transaction began is in neither, and the writer's own write then fails. */
static void one_handle(void) {
  arena a = {0};
  cx c = {&a, NULL, {0}};
  str path = fixture(&a, "11", "onehandle");
  sqlite3 *setup = raw_open(path.p);
  exec(setup, "PRAGMA journal_mode = WAL; UPDATE col SET mod = 1000");
  sqlite3_close(setup);
  conn k = {0};
  k.db = raw_open(path.p);
  exec(k.db, "BEGIN");
  CHECK(scalar(k.db, "SELECT mod FROM col") == 1000, "the writer's snapshot");
  sqlite3 *anki = raw_open(path.p);
  exec(anki, "UPDATE col SET mod = 2000");
  sqlite3_close(anki);
  str dst = ensure_backup_on(&c, path, &k);
  CHECK(dst.p && scalar_in(dst.p, "SELECT mod FROM col") == 1000, "the backup is the writer's snapshot (%lld)",
        dst.p ? (long long)scalar_in(dst.p, "SELECT mod FROM col") : -1LL);
  ledger_entry *rec = ledger_find(path_resolve(&a, path));
  CHECK(rec && rec->mark && strstr(rec->mark, ":1000:"), "and so is the mark the ledger keeps (%s)", rec && rec->mark ? rec->mark : "none");
  int rc = sqlite3_exec(k.db, "UPDATE col SET mod = 3000", NULL, NULL, NULL);
  CHECK(rc == SQLITE_BUSY && sqlite3_extended_errcode(k.db) == SQLITE_BUSY_SNAPSHOT, "the write on a stale snapshot fails (%d)",
        sqlite3_extended_errcode(k.db));
  exec(k.db, "ROLLBACK");

  /* Inside BEGIN IMMEDIATE, SQLite cannot back up the connection: refused, nothing left behind. */
  str path2 = fixture(&a, "11", "immediate");
  conn k2 = {0};
  k2.db = raw_open(path2.p);
  exec(k2.db, "BEGIN IMMEDIATE");
  backup_run r = {path2, &k2, {NULL, 0}, path_resolve(&a, path2), now_ms(), {NULL, 0}, 0, 0};
  int threw = cx_try(&c, backup_body, &r) < 0;
  CHECK(threw && strstr(c.err.message.p, "before the write lock"), "a backup after the write lock is refused");
  CHECK(bak_names(&a, path2) == 0 && tmp_names(&a, path2) == 0, "and leaves nothing");
  exec(k2.db, "ROLLBACK");
  conn_close(&k2);
  conn_close(&k);
  ar_free(&a);
}

/* A collection Anki holds (an exclusive lock, as Anki takes) is never copied: through a handle of
 * its own the backup skips it, and on the caller's handle the copy fails and its temporary file
 * goes with it. */
static void locked_source(void) {
  arena a = {0};
  cx c = {&a, NULL, {0}};
  str path = fixture(&a, "18", "held");
  sqlite3 *anki = raw_open(path.p);
  exec(anki, "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN; UPDATE col SET usn = usn; COMMIT;");
  str dst;
  int threw = try_ensure(&c, path, NULL, &dst) < 0;
  CHECK(!threw && !dst.p, "its own handle: no backup, no error (%s)", threw ? c.err.message.p : "");
  CHECK(bak_names(&a, path) == 0 && tmp_names(&a, path) == 0, "and nothing in the folder");
  conn k = {0};
  k.db = raw_open(path.p);
  threw = try_ensure(&c, path, &k, &dst) < 0;
  CHECK(threw, "the caller's handle: the copy fails");
  CHECK(bak_names(&a, path) == 0 && tmp_names(&a, path) == 0, "and leaves nothing (%zu, %zu)", bak_names(&a, path), tmp_names(&a, path));
  conn_close(&k);
  sqlite3_close(anki);
  ar_free(&a);
}

/* The listing finds backups when the file system leaves d_type DT_UNKNOWN, and still only regular
 * files: a symlink or a folder under a backup's name is not one. */
static void unknown_d_type(void) {
  arena a = {0};
  cx c = {&a, NULL, {0}};
  str path = fixture(&a, "18", "dtype");
  int64_t jan1 = 1767225600000;
  for (int i = 0; i < 12; i++) plant(&a, path, jan1 + i * 1000, "x");
  char stamp[32], name[4096];
  stamp_of(jan1 - 5000, stamp);
  snprintf(name, sizeof name, "%s/collection.anki2.%s.bak", backups_dir(&a, path), stamp);
  if (symlink(path.p, name) != 0) die("symlink");
  stamp_of(jan1 - 6000, stamp);
  snprintf(name, sizeof name, "%s/collection.anki2.%s.bak", backups_dir(&a, path), stamp);
  if (mkdir(name, 0777) != 0) die("mkdir");
  unknown_types = 1;
  size_t n;
  list_backups(&c, path, &n);
  CHECK(n == 12, "the twelve regular backups are listed (%zu)", n);
  prune_backups(&c, path, now_ms());
  unknown_types = 0;
  CHECK(bak_names(&a, path) == 12, "ten kept, two pruned, the symlink and the folder left (%zu)", bak_names(&a, path));
  list_backups(&c, path, &n);
  CHECK(n == 10, "ten backups now (%zu)", n);
  struct stat sb;
  CHECK(lstat(name, &sb) == 0 && S_ISDIR(sb.st_mode), "the folder is there");
  ar_free(&a);
}

/* The backup opens in real Anki, and Check Database finds nothing, on both schemas, with a change
 * still in the -wal when it is taken. */
static void opens_in_anki(void) {
  const char *py = getenv("ANKI_PYTHON_BIN");
  if (!py || !*py) {
    printf("backup_unit: skipped the real Anki check (ANKI_PYTHON_BIN unset)\n");
    return;
  }
  const char *schemas[] = {"11", "18"};
  for (int s = 0; s < 2; s++) {
    arena a = {0};
    cx c = {&a, NULL, {0}};
    str path = fixture(&a, schemas[s], ar_fmt(&a, "anki%s", schemas[s]));
    sqlite3 *writer = raw_open(path.p);
    exec(writer, "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE col SET mod = mod + 1");
    int64_t mod = scalar(writer, "SELECT mod FROM col");
    conn k = {0};
    k.db = raw_open(path.p);
    str dst = ensure_backup_on(&c, path, &k);
    conn_close(&k);
    sqlite3_close(writer);
    CHECK(dst.p != NULL, "schema %s: a backup", schemas[s]);
    if (!dst.p) continue;
    /* Anki opens it as a collection of its own, in a folder of its own. */
    char dir[4096], col[4096];
    snprintf(dir, sizeof dir, "%s/anki-open-%s", scratch, schemas[s]);
    mkdir(dir, 0777);
    snprintf(col, sizeof col, "%s/collection.anki2", dir);
    copy_file(dst.p, col);
    char cmd[16384];
    snprintf(cmd, sizeof cmd,
             "'%s' -c 'import sys\nfrom anki.collection import Collection\ncol = Collection(sys.argv[1])\n"
             "print(\"mod\", col.db.scalar(\"select mod from col\"))\n"
             "print(\"integrity\", col.db.scalar(\"pragma integrity_check\"))\n"
             "problems, ok = col.fix_integrity()\nprint(\"check database\", ok, problems)\ncol.close()' '%s' 2>&1",
             py, col);
    FILE *p = popen(cmd, "r");
    char out[8192] = {0};
    size_t got = p ? fread(out, 1, sizeof out - 1, p) : 0;
    out[got] = 0;
    if (p) pclose(p);
    CHECK(strstr(out, ar_fmt(&a, "mod %lld\n", (long long)mod)) != NULL, "schema %s: Anki reads the -wal's change: %s", schemas[s], out);
    CHECK(strstr(out, "integrity ok\n") != NULL, "schema %s: integrity ok: %s", schemas[s], out);
    CHECK(strstr(out, "check database True Database rebuilt and optimized.\n") != NULL, "schema %s: Check Database clean: %s",
          schemas[s], out);
    ar_free(&a);
  }
}

int main(int argc, char **argv) {
  root = argc > 1 ? argv[1] : "..";
  const char *tmp = getenv("TMPDIR");
  snprintf(scratch, sizeof scratch, "%s/amgi-backup-unit-XXXXXX", tmp && *tmp ? tmp : "/tmp");
  if (!mkdtemp(scratch)) die("mkdtemp");
  killed_backups();
  wal_covered();
  one_handle();
  locked_source();
  unknown_d_type();
  opens_in_anki();
  char cmd[4200];
  snprintf(cmd, sizeof cmd, "rm -rf '%s'", scratch);
  if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", scratch);
  printf("backup_unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
