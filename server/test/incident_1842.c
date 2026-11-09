/* Incident 18:42 (2026-11-08): Alex's collection.anki2 was left with every page zero except two,
 * header gone, after the page's load requests ran while Anki was closing.
 *
 * What happened, as reproduced on a copy with the anki library (Anki 26.09's rslib):
 *   1. Anki holds the collection in WAL mode with locking_mode=EXCLUSIVE, so its WAL index lives
 *      in its own heap (no -shm) and every other process is told "database is locked".
 *   2. Anki's create_backup (it runs one on close) drops Anki's own lock: a plain open() and close()
 *      of collection.anki2 inside Anki's process releases every POSIX lock that process holds on
 *      the file, sqlite's included. Anki goes on believing it owns the file.
 *   3. Anki keeps writing frames to its -wal.
 *   4. The server opens the collection for a page load (status, the template drift check, the
 *      install), which now succeeds. Its checkpoint backfills Anki's frames and resets the -wal to
 *      zero bytes, under Anki.
 *   5. Anki writes its next small transaction (col.mod and the config row: pages 2 and 7) at the
 *      frame offset it remembers, leaving a hole of zeros where its earlier frames were.
 *   6. Anki's close checkpoints from its heap index: every page whose newest frame is in the hole is
 *      written to collection.anki2 as zeros, and only the pages of the last transaction survive.
 *
 * This test plays Anki with a child process doing exactly 1 to 3, 5 and 6 through sqlite (the lock
 * loss is a raw open and close of the file, as Anki's backup does it), and plays the page load with
 * the server's own collection calls for 4. It holds the rule the server needs: a collection whose
 * -wal has no -shm beside it is held by an exclusive-mode owner (Anki), lock or no lock, and the
 * server must not open it, so the file is whole after the owner closes.
 *
 *   build/incident_1842 <repo root> */
#include <fcntl.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../collection/collection.h"

static int failures, checks;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    checks++;                                              \
    if (!(cond)) {                                         \
      failures++;                                          \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);                        \
      fputc('\n', stderr);                                 \
    }                                                      \
  } while (0)

static void die(const char *what) {
  perror(what);
  exit(2);
}

static void copy_file(const char *from, const char *to) {
  int in = open(from, O_RDONLY), out = open(to, O_WRONLY | O_CREAT | O_EXCL, 0644);
  if (in < 0 || out < 0) die("copy");
  char b[1 << 16];
  ssize_t r;
  while ((r = read(in, b, sizeof b)) > 0)
    if (write(out, b, (size_t)r) != r) die("copy write");
  close(in);
  close(out);
}

static void x(sqlite3 *db, const char *sql) {
  char *err = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
    fprintf(stderr, "anki stand-in: %s: %s\n", sql, err ? err : "?");
    _exit(3);
  }
}

/* One byte down the pipe, or wait for one. */
static void say(int fd) {
  if (write(fd, "x", 1) != 1) _exit(4);
}
static void hear(int fd) {
  char ch;
  if (read(fd, &ch, 1) != 1) _exit(5);
}

/* Anki's collation, near enough for a VACUUM to rebuild the indexes that use it. */
static int unicase(void *ctx, int na, const void *a, int nb, const void *b) {
  (void)ctx;
  int r = sqlite3_strnicmp(a, b, na < nb ? na : nb);
  return r ? r : na - nb;
}

/* Anki, as far as the file is concerned. */
static void anki(const char *path, int to_server, int from_server) {
  sqlite3 *db;
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) _exit(6);
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, NULL, unicase);
  x(db, "PRAGMA locking_mode = EXCLUSIVE");
  x(db, "PRAGMA journal_mode = WAL");
  x(db, "UPDATE col SET mod = mod + 1"); /* the session's work: the lock is taken here */
  /* create_backup: the WAL folded in and reset, then the file read with a plain open and close,
   * which drops this process's locks on it. */
  x(db, "PRAGMA wal_checkpoint(TRUNCATE)");
  int raw = open(path, O_RDONLY);
  if (raw < 0) _exit(7);
  char page[4096];
  if (read(raw, page, sizeof page) != (ssize_t)sizeof page) _exit(8);
  close(raw);
  /* Anki writes on: a transaction over the whole file (a VACUUM here; Anki's own writes after its
   * backup), all of it in the -wal. */
  x(db, "VACUUM");
  say(to_server);
  hear(from_server); /* the page load ran */
  /* The last small transaction (pages 2 and 7 in Alex's file), then the close's checkpoint. */
  x(db, "UPDATE col SET mod = mod + 1");
  x(db, "UPDATE config SET mtime_secs = mtime_secs + 1 WHERE KEY = 'curDeck'");
  if (sqlite3_close(db) != SQLITE_OK) _exit(9);
  _exit(0);
}

/* The file's state: pages, zero pages, whether page 1 starts with the SQLite header. */
static void file_shape(const char *path, long *pages, long *zero, int *header) {
  *pages = *zero = 0;
  *header = 0;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return;
  char p[4096];
  static const char magic[16] = "SQLite format 3";
  while (read(fd, p, sizeof p) == (ssize_t)sizeof p) {
    int all = 1;
    for (size_t i = 0; i < sizeof p && all; i++) all = !p[i];
    if (*pages == 0) *header = !memcmp(p, magic, 16);
    (*pages)++;
    *zero += all;
  }
  close(fd);
}

int main(int argc, char **argv) {
  if (argc < 2) return fprintf(stderr, "usage: %s <repo root>\n", argv[0]), 2;
  char dir[] = "/tmp/amgi-incident-1842-XXXXXX";
  const char *tmp = getenv("TMPDIR");
  char tmpl[4096];
  snprintf(tmpl, sizeof tmpl, "%s/amgi-incident-1842-XXXXXX", tmp && *tmp ? tmp : "/tmp");
  char *made = mkdtemp(tmp && *tmp ? tmpl : dir);
  if (!made) die("mkdtemp");
  char fixture[4096], path[4096];
  snprintf(fixture, sizeof fixture, "%s/test/parity/fixtures/schema18/collection.anki2", argv[1]);
  snprintf(path, sizeof path, "%s/collection.anki2", made);
  copy_file(fixture, path);

  int up[2], down[2];
  if (pipe(up) || pipe(down)) die("pipe");
  pid_t child = fork();
  if (child < 0) die("fork");
  if (child == 0) {
    close(up[0]);
    close(down[1]);
    anki(path, up[1], down[0]);
  }
  close(up[1]);
  close(down[0]);
  hear(up[0]); /* Anki is open, unlocked by its own backup, with a full -wal */

  /* The page load: the status probe and the template drift check's read, as the server runs them. */
  arena a = {0};
  str p = {path, strlen(path)};
  col_state st = {0};
  col_err e = {0};
  int r = col_status(&a, p, &st, &e);
  CHECK(r == 0 && st.status && strcmp(st.status, "ok") != 0,
        "the status probe opened a collection whose -wal has no -shm (Anki's, exclusive mode): status %s",
        r == 0 && st.status ? st.status : "(error)");
  col_notetype *nts;
  size_t n;
  col_err e2 = {0};
  int listed = col_list_notetypes(&a, p, &nts, &n, &e2);
  CHECK(listed != 0, "the drift check read the notetypes of a collection Anki holds (-wal, no -shm)");

  say(down[1]);
  int status;
  if (waitpid(child, &status, 0) != child) die("waitpid");
  CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0, "the Anki stand-in failed (exit %d)", WEXITSTATUS(status));

  long pages, zero;
  int header;
  file_shape(path, &pages, &zero, &header);
  CHECK(header, "collection.anki2 lost its SQLite header after Anki closed (%ld pages, %ld zero)", pages, zero);
  CHECK(zero == 0, "collection.anki2 has %ld zero pages of %ld after Anki closed", zero, pages);
  sqlite3 *db;
  int ok = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK &&
           sqlite3_exec(db, "SELECT count(*) FROM notes", NULL, NULL, NULL) == SQLITE_OK;
  sqlite3_close(db);
  CHECK(ok, "collection.anki2 does not open after Anki closed");

  ar_free(&a);
  if (failures) fprintf(stderr, "kept for a look: %s\n", made);
  printf("incident_1842: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
