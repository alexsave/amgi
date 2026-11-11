/* Tests of the collection's media folder (server/collection/media.c) by itself: a write is never
 * seen half done under its final name, whatever stops it (a short write, a failed write, fsync or
 * rename, the process killed mid-way), and leaves no temporary file behind when it fails; addMedia
 * names a file exactly as it did; and hasMedia, readMedia and col_media_path agree on what is a
 * media file (no symlink, a regular file, at most 256 MiB). media.c is built with MEDIA_FAULTS
 * here, which adds the one-shot fault below and nothing else. Run under ASan and UBSan by
 * `make -C server check-collection`.
 *
 *   build/media_unit */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../../../server/collection/core.h"

str media_dir_for(cx *c, str collection);
str media_add(cx *c, str dir, str desired, const void *data, size_t len);
int media_write_fixed(cx *c, str dir, str name, const void *data, size_t len);
int media_exists(cx *c, str dir, str name);
int media_read(cx *c, str dir, str name, str *out);

enum { MEDIA_FAULT_NONE, MEDIA_FAULT_SHORT, MEDIA_FAULT_WRITE, MEDIA_FAULT_FSYNC, MEDIA_FAULT_RENAME, MEDIA_FAULT_KILL, MEDIA_FAULT_APPEAR };
typedef struct { int kind; size_t after; } media_fault;
extern media_fault media_fault_next;

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

static char scratch[4096];

/* A fresh media folder under this run's scratch folder. */
static str fresh_dir(arena *a, const char *name) {
  char d[4096];
  snprintf(d, sizeof d, "%s/%s", scratch, name);
  mkdir(d, 0777);
  return str_c(ar_dup(a, d, strlen(d)));
}

/* The names in a folder, "." and ".." aside. */
static size_t count_entries(str dir) {
  char z[4096];
  snprintf(z, sizeof z, "%.*s", (int)dir.n, dir.p);
  DIR *d = opendir(z);
  if (!d) return 0;
  size_t n = 0;
  struct dirent *e;
  while ((e = readdir(d)))
    if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) n++;
  closedir(d);
  return n;
}

static int file_is(str dir, const char *name, const void *data, size_t len) {
  char p[4096];
  snprintf(p, sizeof p, "%.*s/%s", (int)dir.n, dir.p, name);
  FILE *f = fopen(p, "rb");
  if (!f) return 0;
  char *got = malloc(len + 1);
  size_t n = fread(got, 1, len + 1, f);
  fclose(f);
  int same = n == len && !memcmp(got, data, len);
  free(got);
  return same;
}

static void put_file(str dir, const char *name, const char *text) {
  char p[4096];
  snprintf(p, sizeof p, "%.*s/%s", (int)dir.n, dir.p, name);
  FILE *f = fopen(p, "wb");
  fputs(text, f);
  fclose(f);
}

/* A clip-sized buffer, bytes from a fixed pattern (no randomness: the same bytes every run). */
static char *clip(size_t n, unsigned salt) {
  char *p = malloc(n);
  for (size_t i = 0; i < n; i++) p[i] = (char)((i * 131u + salt * 7u + (i >> 9)) & 0xff);
  return p;
}

typedef struct { str dir, name; const void *data; size_t len; str stored; int fixed; } write_args;
static void do_write(cx *c, void *arg) {
  write_args *w = arg;
  if (w->fixed) media_write_fixed(c, w->dir, w->name, w->data, w->len);
  else w->stored = media_add(c, w->dir, w->name, w->data, w->len);
}
/* addMedia (or writeFixedNameMedia): 0, or -1 when it threw. */
static int add(arena *a, str dir, const char *name, const void *data, size_t len, str *stored) {
  cx c = {a, NULL, {0}};
  write_args w = {dir, str_c(name), data, len, {0}, 0};
  int r = cx_try(&c, do_write, &w);
  if (stored) *stored = w.stored;
  return r;
}
static int add_fixed(arena *a, str dir, const char *name, const void *data, size_t len) {
  cx c = {a, NULL, {0}};
  write_args w = {dir, str_c(name), data, len, {0}, 1};
  return cx_try(&c, do_write, &w);
}

static int has(arena *a, str dir, const char *name) {
  cx c = {a, NULL, {0}};
  return media_exists(&c, dir, str_c(name));
}
static int readable(arena *a, str dir, const char *name) {
  cx c = {a, NULL, {0}};
  str out;
  return media_read(&c, dir, str_c(name), &out);
}

/* ---- a write stopped part way: never a short file under the final name, no temporary left ---- */
static void stopped_writes(void) {
  arena a = {0};
  size_t len = 300000;
  char *data = clip(len, 1);
  struct { int kind; size_t after; const char *what; } stops[] = {
      {MEDIA_FAULT_WRITE, 100000, "a write that fails part way"},
      {MEDIA_FAULT_WRITE, 0, "a write that fails at once"},
      {MEDIA_FAULT_FSYNC, 0, "an fsync that fails"},
      {MEDIA_FAULT_RENAME, 0, "a rename that fails"},
  };
  for (size_t i = 0; i < sizeof stops / sizeof *stops; i++) {
    char nm[64];
    snprintf(nm, sizeof nm, "stopped-%zu.media", i);
    str dir = fresh_dir(&a, nm);
    media_fault_next = (media_fault){stops[i].kind, stops[i].after};
    CHECK(add(&a, dir, "clip.wav", data, len, NULL) < 0, "%s: addMedia fails", stops[i].what);
    CHECK(!has(&a, dir, "clip.wav"), "%s: hasMedia does not report the clip", stops[i].what);
    CHECK(!readable(&a, dir, "clip.wav"), "%s: readMedia does not find it", stops[i].what);
    CHECK(count_entries(dir) == 0, "%s: nothing is left in the folder (%zu entries)", stops[i].what, count_entries(dir));
    /* And the next try writes it whole, under the name asked for. */
    str stored;
    CHECK(add(&a, dir, "clip.wav", data, len, &stored) == 0 && str_eq_c(stored, "clip.wav"), "%s: a retry stores it", stops[i].what);
    CHECK(file_is(dir, "clip.wav", data, len) && count_entries(dir) == 1, "%s: the retry's file is whole and alone", stops[i].what);
  }

  /* A file other files load by name is replaced whole or not at all: a failed replacement leaves
   * the old bytes, never a truncated mix. */
  str dir = fresh_dir(&a, "fixed.media");
  put_file(dir, "_amgi.css", "the old style");
  int kinds[] = {MEDIA_FAULT_WRITE, MEDIA_FAULT_FSYNC, MEDIA_FAULT_RENAME};
  for (size_t i = 0; i < sizeof kinds / sizeof *kinds; i++) {
    media_fault_next = (media_fault){kinds[i], 3};
    CHECK(add_fixed(&a, dir, "_amgi.css", "the new style, longer", 21) < 0, "a failed replacement (%d) fails", kinds[i]);
    CHECK(file_is(dir, "_amgi.css", "the old style", 13), "a failed replacement (%d) keeps the old bytes", kinds[i]);
    CHECK(count_entries(dir) == 1, "a failed replacement (%d) leaves no temporary (%zu entries)", kinds[i], count_entries(dir));
  }
  CHECK(add_fixed(&a, dir, "_amgi.css", "the new style, longer", 21) == 0 && file_is(dir, "_amgi.css", "the new style, longer", 21),
        "an unfaulted replacement writes the new bytes");
  free(data);
  ar_free(&a);
}

/* ---- short writes: the loop finishes the file ---- */
static void short_writes(void) {
  arena a = {0};
  str dir = fresh_dir(&a, "short.media");
  size_t len = 70001;
  char *data = clip(len, 2);
  media_fault_next = (media_fault){MEDIA_FAULT_SHORT, 7};
  str stored;
  CHECK(add(&a, dir, "short.mp3", data, len, &stored) == 0 && str_eq_c(stored, "short.mp3"), "short writes: stored");
  CHECK(file_is(dir, "short.mp3", data, len), "short writes: the file is whole");
  CHECK(count_entries(dir) == 1, "short writes: only the clip is there (%zu entries)", count_entries(dir));
  free(data);
  ar_free(&a);
}

/* ---- the process killed mid-way through a write ---- */
static void killed_write(void) {
  arena a = {0};
  str dir = fresh_dir(&a, "killed.media");
  size_t len = 200000;
  char *data = clip(len, 3);
  fflush(NULL);
  pid_t pid = fork();
  if (pid == 0) {
    media_fault_next = (media_fault){MEDIA_FAULT_KILL, 65536};
    add(&a, dir, "killed.wav", data, len, NULL);
    _exit(0); /* not reached: the fault kills the process with half the clip written */
  }
  int st = 0;
  waitpid(pid, &st, 0);
  CHECK(WIFSIGNALED(st) && WTERMSIG(st) == SIGKILL, "the writer was killed mid-way (status %d)", st);
  CHECK(!has(&a, dir, "killed.wav"), "after a kill, hasMedia does not report the clip");
  CHECK(!readable(&a, dir, "killed.wav"), "after a kill, readMedia does not find it");
  /* What a kill leaves is the temporary, hidden (a leading dot, which Anki's media check skips),
   * and it never stands in the way of the next write. */
  char z[4096];
  snprintf(z, sizeof z, "%.*s", (int)dir.n, dir.p);
  DIR *d = opendir(z);
  size_t hidden = 0, shown = 0;
  struct dirent *e;
  while (d && (e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    if (e->d_name[0] == '.') hidden++;
    else shown++;
  }
  if (d) closedir(d);
  CHECK(hidden == 1 && shown == 0, "a kill leaves one hidden temporary and nothing else (%zu hidden, %zu shown)", hidden, shown);
  str stored;
  CHECK(add(&a, dir, "killed.wav", data, len, &stored) == 0 && str_eq_c(stored, "killed.wav"), "the next write stores it under its name");
  CHECK(file_is(dir, "killed.wav", data, len) && has(&a, dir, "killed.wav"), "and whole");
  free(data);
  ar_free(&a);
}

/* ---- addMedia's naming, as media.js names (unchanged by the atomic write) ---- */
static int case_sensitive(arena *a) {
  str dir = fresh_dir(a, "case-probe");
  put_file(dir, "A", "x");
  char p[4096];
  snprintf(p, sizeof p, "%.*s/a", (int)dir.n, dir.p);
  return access(p, F_OK) != 0;
}

static void naming(void) {
  arena a = {0};
  str dir = fresh_dir(&a, "naming.media"), stored;
  const char *one = "first take", *two = "second take", *three = "third take";
  char sha2[41], sha3[41];
  sha1_hex(two, strlen(two), sha2);
  sha1_hex(three, strlen(three), sha3);

  CHECK(add(&a, dir, "word.mp3", one, strlen(one), &stored) == 0 && str_eq_c(stored, "word.mp3"), "a new name is kept");
  CHECK(add(&a, dir, "word.mp3", one, strlen(one), &stored) == 0 && str_eq_c(stored, "word.mp3"), "the same bytes again: the same name");
  CHECK(count_entries(dir) == 1, "and no second file");
  char want[128];
  snprintf(want, sizeof want, "word-%s.mp3", sha2);
  CHECK(add(&a, dir, "word.mp3", two, strlen(two), &stored) == 0 && str_eq_c(stored, want),
        "a different take of a taken lower-case name gets the hash suffix (%.*s)", (int)stored.n, stored.p);
  CHECK(file_is(dir, "word.mp3", one, strlen(one)) && file_is(dir, want, two, strlen(two)), "both takes are kept whole");
  CHECK(add(&a, dir, "word.mp3", two, strlen(two), &stored) == 0 && str_eq_c(stored, want), "the second take again: its suffixed name");
  CHECK(count_entries(dir) == 2, "and still two files (%zu)", count_entries(dir));

  /* A mixed-case name: kept; a different take tries the lower-case name next, then the suffix of
   * the lower-case name. On a case-insensitive folder the lower-case name is the same file. */
  int cs = case_sensitive(&a);
  CHECK(add(&a, dir, "Word.MP3", one, strlen(one), &stored) == 0 && str_eq_c(stored, "Word.MP3"),
        "a mixed-case name is kept (%.*s)", (int)stored.n, stored.p);
  snprintf(want, sizeof want, "word-%s.mp3", sha3);
  CHECK(add(&a, dir, "Word.MP3", three, strlen(three), &stored) == 0 && str_eq_c(stored, want),
        "a take neither candidate holds: the lower-case stem with the hash (%.*s)", (int)stored.n, stored.p);
  CHECK(file_is(dir, want, three, strlen(three)), "the third take is whole");
  /* The lower-case candidate, when it is free: only a case-sensitive folder has it free. */
  str dir2 = fresh_dir(&a, "naming2.media");
  CHECK(add(&a, dir2, "Take.wav", one, strlen(one), &stored) == 0 && str_eq_c(stored, "Take.wav"), "Take.wav kept");
  snprintf(want, sizeof want, "take-%s.wav", sha2);
  CHECK(add(&a, dir2, "Take.wav", two, strlen(two), &stored) == 0 && str_eq_c(stored, cs ? "take.wav" : want),
        "a second take of Take.wav is %s (%.*s)", cs ? "take.wav" : want, (int)stored.n, stored.p);
  CHECK(file_is(dir2, "Take.wav", one, strlen(one)), "and the first take is untouched");

  /* A file that appears at the free name between the look and the write (another process's) is
   * never replaced: addMedia looks again, and the next candidate takes the bytes. */
  str dir3 = fresh_dir(&a, "naming3.media");
  media_fault_next = (media_fault){MEDIA_FAULT_APPEAR, 0};
  snprintf(want, sizeof want, "late-%s.wav", sha2);
  CHECK(add(&a, dir3, "late.wav", two, strlen(two), &stored) == 0 && str_eq_c(stored, want),
        "a file that appeared at late.wav sends the take to its suffixed name (%.*s)", (int)stored.n, stored.p);
  CHECK(file_is(dir3, "late.wav", "appeared", 8), "and the file that appeared is kept");
  CHECK(file_is(dir3, want, two, strlen(two)) && count_entries(dir3) == 2, "the take is whole, and no temporary is left");

  /* The name is cleaned as normalizeFilename cleans it: the base name, no control characters. */
  CHECK(add(&a, dir, "some/dir/a\x01" "b.wav", one, strlen(one), &stored) == 0 && str_eq_c(stored, "ab.wav"),
        "a path and a control character are dropped (%.*s)", (int)stored.n, stored.p);
  const char *refused[] = {"", ".", "..", "dir/..", "\x01\x02"};
  for (size_t i = 0; i < sizeof refused / sizeof *refused; i++)
    CHECK(add(&a, dir, refused[i], one, strlen(one), NULL) < 0, "the name \"%s\" is refused", refused[i]);
  ar_free(&a);
}

/* ---- one rule for what is a media file: hasMedia, readMedia and col_media_path agree ---- */
static void one_rule(void) {
  arena a = {0};
  str dir = fresh_dir(&a, "rule.media");
  /* col_media_path takes the collection's path; its media folder is rule.media. */
  char colz[4096];
  snprintf(colz, sizeof colz, "%s/rule.anki2", scratch);
  str col = str_c(colz);
  put_file(dir, "clip.wav", "a clip");
  char outside[4096], p[4096];
  snprintf(outside, sizeof outside, "%s/secret.txt", scratch);
  FILE *f = fopen(outside, "w");
  fputs("outside", f);
  fclose(f);
  snprintf(p, sizeof p, "%.*s/out.wav", (int)dir.n, dir.p);
  CHECK(symlink(outside, p) == 0, "symlink out");
  snprintf(p, sizeof p, "%.*s/in.wav", (int)dir.n, dir.p);
  CHECK(symlink("clip.wav", p) == 0, "symlink in");
  snprintf(p, sizeof p, "%.*s/fifo.wav", (int)dir.n, dir.p);
  CHECK(mkfifo(p, 0600) == 0, "mkfifo");
  snprintf(p, sizeof p, "%.*s/sub.wav", (int)dir.n, dir.p);
  mkdir(p, 0777);
  /* Past the 256 MiB cap, sparse so it costs no disk. */
  snprintf(p, sizeof p, "%.*s/huge.wav", (int)dir.n, dir.p);
  int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  CHECK(fd >= 0 && ftruncate(fd, (off_t)(256u << 20) + 1) == 0, "a huge sparse file");
  if (fd >= 0) close(fd);
  snprintf(p, sizeof p, "%.*s/edge.wav", (int)dir.n, dir.p);
  fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  CHECK(fd >= 0 && ftruncate(fd, (off_t)(256u << 20)) == 0, "a file at the cap");
  if (fd >= 0) close(fd);

  struct { const char *name; int is; } cases[] = {
      {"clip.wav", 1}, {"edge.wav", 1}, {"out.wav", 0}, {"in.wav", 0}, {"fifo.wav", 0}, {"sub.wav", 0},
      {"huge.wav", 0}, {"none.wav", 0}, {"../rule.media/clip.wav", 0}, {"a/b", 0}, {"a\\b", 0}, {"..", 0}, {".", 0}, {"", 0},
  };
  for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
    const char *nm = cases[i].name;
    CHECK(has(&a, dir, nm) == cases[i].is, "hasMedia(\"%s\") is %d", nm, cases[i].is);
    if (strcmp(nm, "edge.wav")) /* reading 256 MiB is the read path's cost, not this rule's */
      CHECK(readable(&a, dir, nm) == cases[i].is, "readMedia(\"%s\") finds it: %d", nm, cases[i].is);
    int found = -1;
    str file = {0};
    col_err e = {0};
    CHECK(col_media_path(&a, col, str_c(nm), &found, &file, &e) == 0 && found == cases[i].is, "col_media_path(\"%s\") found %d", nm,
          cases[i].is);
    if (cases[i].is) {
      char want[4096];
      snprintf(want, sizeof want, "%.*s/%s", (int)dir.n, dir.p, nm);
      CHECK(str_eq_c(file, want) && file.p[file.n] == 0, "col_media_path(\"%s\") is the file in the folder (%.*s)", nm, (int)file.n,
            file.p);
    }
  }
  ar_free(&a);
}

int main(void) {
  const char *tmp = getenv("TMPDIR");
  if (!tmp || !*tmp) tmp = "/tmp";
  size_t tn = strlen(tmp);
  while (tn > 1 && tmp[tn - 1] == '/') tn--; /* col_media_path's path is normalised */
  snprintf(scratch, sizeof scratch, "%.*s/amgi-media-unit-XXXXXX", (int)tn, tmp);
  if (!mkdtemp(scratch)) {
    perror("mkdtemp");
    return 2;
  }
  naming();
  short_writes();
  stopped_writes();
  killed_write();
  one_rule();
  char cmd[4200];
  snprintf(cmd, sizeof cmd, "rm -rf '%s'", scratch);
  if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", scratch);
  printf("media_unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
