/* Anki, as far as collection.anki2 is concerned, for the incident 18:42 browser drive
 * (tests/e2e/ui/incident1842.mjs). The same steps as tests/server/c/incident_1842.c's child, as a program
 * of its own so a drive can run it beside a real server and a real page:
 *
 *   1. open the collection in WAL mode with locking_mode=EXCLUSIVE (Anki's way: the WAL index lives
 *      in this process's heap, there is no -shm, and every other opener is told "locked");
 *   2. create_backup: the -wal folded in and reset, then the file read with a plain open() and
 *      close(), which drops every POSIX lock this process holds on it, sqlite's included;
 *   3. write on: a transaction over the whole file (a VACUUM), all of it in the -wal;
 *   then it prints "held" and waits for a line on stdin (the page loads run in this window);
 *   4. its last small transaction (col.mod and the curDeck config row) and the close's checkpoint,
 *      then "closed".
 *
 * If a second opener reset the -wal in the window, step 4 lands after a hole of zeros and the close
 * copies the hole into collection.anki2: the header and every page but the last transaction's go.
 *
 *   build/anki_standin <collection.anki2>      exit 0 once closed, 3 to 9 on a failed step */
#include <fcntl.h>
#include <sqlite3.h>
#include <stdio.h>
#include <unistd.h>

static void x(sqlite3 *db, const char *sql) {
  char *err = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
    fprintf(stderr, "anki stand-in: %s: %s\n", sql, err ? err : "?");
    _exit(3);
  }
}

/* Anki's collation, near enough for a VACUUM to rebuild the indexes that use it. */
static int unicase(void *ctx, int na, const void *a, int nb, const void *b) {
  (void)ctx;
  int r = sqlite3_strnicmp(a, b, na < nb ? na : nb);
  return r ? r : na - nb;
}

int main(int argc, char **argv) {
  if (argc != 2) return fprintf(stderr, "usage: %s <collection.anki2>\n", argv[0]), 2;
  const char *path = argv[1];
  sqlite3 *db;
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) _exit(6);
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, NULL, unicase);
  x(db, "PRAGMA locking_mode = EXCLUSIVE");
  x(db, "PRAGMA journal_mode = WAL");
  x(db, "UPDATE col SET mod = mod + 1"); /* the session's work: the lock is taken here */
  x(db, "PRAGMA wal_checkpoint(TRUNCATE)");
  int raw = open(path, O_RDONLY);
  if (raw < 0) _exit(7);
  char page[4096];
  if (read(raw, page, sizeof page) != (ssize_t)sizeof page) _exit(8);
  close(raw); /* the backup's plain read: this process's locks on the file are gone */
  x(db, "VACUUM");
  printf("held\n");
  fflush(stdout);
  char line[16];
  if (!fgets(line, sizeof line, stdin)) _exit(4);
  x(db, "UPDATE col SET mod = mod + 1");
  x(db, "UPDATE config SET mtime_secs = mtime_secs + 1 WHERE KEY = 'curDeck'");
  if (sqlite3_close(db) != SQLITE_OK) _exit(9);
  printf("closed\n");
  fflush(stdout);
  return 0;
}
