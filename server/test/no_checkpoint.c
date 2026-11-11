/* The incident-1842 rule: no explicit checkpoint in amgi's shipped code.
 *
 * The lock rule (skills/amgi/references/collection-internals.md): a -wal with no -shm beside it is an
 * exclusive-mode owner (Anki, or an Anki that crashed), and amgi reports the collection locked without
 * opening it. amgi never checkpoints a WAL itself. Why: Anki's own backup on close drops its exclusive
 * lock, and a second SQLite connection's checkpoint then resets Anki's live -wal; the incident of
 * 2026-11-08 (docs/INCIDENT_1842.md) emptied a real collection that way.
 *
 * Every tracked source file that ships (srcscan.h), in C, JavaScript and the add-on's Python, with
 * comments blanked, is scanned for a checkpoint asked for by name: the wal_checkpoint pragma, the
 * sqlite3_wal_checkpoint functions, and the SQLITE_CHECKPOINT_* modes. Any hit fails. Turning the
 * automatic checkpoint off (wal_autocheckpoint) is not asking for one.
 *
 *   build/no_checkpoint <repo root> <tracked files, relative to the root...>
 *
 * Run by `make -C server check-collection`. Exit status is 1 when a shipped file checkpoints, or the
 * scan is blind to a file it must see. */
#include "srcscan.h"

static int checks, failures;

#define CHECK(cond, ...)                                  \
  do {                                                    \
    checks++;                                             \
    if (!(cond)) {                                        \
      failures++;                                         \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);                       \
      fputc('\n', stderr);                                \
    }                                                     \
  } while (0)

/* Every checkpoint asked for in code (comments already blanked), as "line: text" lines into out.
 * Returns how many. The pattern is /wal_checkpoint|SQLITE_CHECKPOINT_[A-Z]+/, scanned left to right. */
static size_t find_checkpoints(const char *code, size_t n, char *out, size_t cap) {
  static const char word[] = "wal_checkpoint";
  static const char mode[] = "SQLITE_CHECKPOINT_";
  size_t hits = 0, o = 0, line = 1, i = 0;
  out[0] = 0;
  while (i < n) {
    if (code[i] == '\n') { line++; i++; continue; }
    size_t len = 0;
    if (i + sizeof word - 1 <= n && memcmp(code + i, word, sizeof word - 1) == 0) {
      len = sizeof word - 1;
    } else if (i + sizeof mode - 1 <= n && memcmp(code + i, mode, sizeof mode - 1) == 0) {
      size_t j = i + sizeof mode - 1;
      while (j < n && code[j] >= 'A' && code[j] <= 'Z') j++;
      if (j > i + sizeof mode - 1) len = j - i;
    }
    if (len == 0) { i++; continue; }
    int wrote = snprintf(out + o, cap - o, "%zu: %.*s\n", line, (int)len, code + i);
    if (wrote < 0 || (size_t)wrote >= cap - o) { out[o] = 0; return hits; }
    o += (size_t)wrote;
    hits++;
    i += len;
  }
  return hits;
}

/* The checkpoints in one file's source, after blanking its comments for its language. */
static size_t file_checkpoints(const char *rel, const char *src, size_t n, char *out, size_t cap) {
  size_t code_n = 0;
  char *code = ends_with(rel, ".py") ? strip_py(src, n, &code_n) : strip_js(src, n, &code_n);
  if (!code) { out[0] = 0; return 0; }
  size_t hits = find_checkpoints(code, code_n, out, cap);
  free(code);
  return hits;
}

static int same(const char *got, const char *want) { return strcmp(got, want) == 0; }

/* The scan finds a checkpoint in each language, and not in a comment. */
static void test_scan(void) {
  char out[512];
  const char *c1 = "conn_exec(c, k, \"PRAGMA wal_checkpoint(TRUNCATE)\");\n// wal_checkpoint\n";
  file_checkpoints("x.c", c1, strlen(c1), out, sizeof out);
  CHECK(same(out, "1: wal_checkpoint\n"), "C string and comment: got \"%s\"", out);
  const char *c2 = "/* a\n wal_checkpoint */\nsqlite3_wal_checkpoint_v2(db, NULL, SQLITE_CHECKPOINT_TRUNCATE, 0, 0);\n";
  file_checkpoints("x.c", c2, strlen(c2), out, sizeof out);
  CHECK(same(out, "3: wal_checkpoint\n3: SQLITE_CHECKPOINT_TRUNCATE\n"), "C block comment and mode: got \"%s\"", out);
  const char *js = "db.exec('PRAGMA wal_checkpoint(PASSIVE)'); // wal_checkpoint\n";
  file_checkpoints("x.js", js, strlen(js), out, sizeof out);
  CHECK(same(out, "1: wal_checkpoint\n"), "JavaScript string and comment: got \"%s\"", out);
  const char *py = "# wal_checkpoint\n\"\"\"wal_checkpoint\"\"\"\ndb.execute(\"pragma wal_checkpoint\")\n";
  file_checkpoints("x.py", py, strlen(py), out, sizeof out);
  CHECK(same(out, "3: wal_checkpoint\n"), "Python comment and docstring: got \"%s\"", out);
  const char *off = "PRAGMA wal_autocheckpoint = 0\n";
  file_checkpoints("x.c", off, strlen(off), out, sizeof out);
  CHECK(same(out, ""), "turning the automatic checkpoint off is not asking for one: got \"%s\"", out);
}

/* The shipped predicate: which tracked paths the scan reads. */
static void test_shipped(void) {
  CHECK(shipped("server/collection/db.c"), "a C source ships");
  CHECK(shipped("plusaudio/generate-clip.js"), "a JavaScript source ships");
  CHECK(shipped("anki/addon/amgi_bridge/bridge_ops.py"), "a Python source ships");
  CHECK(!shipped("server/test/c_rules.c"), "a file under test/ does not ship");
  CHECK(!shipped("anki/addon/amgi_bridge/test/test_x.py"), "a file under a test folder does not ship");
  CHECK(!shipped("server/tools/x.c"), "a file under tools/ does not ship");
  CHECK(!shipped("plusaudio/random.test.js"), "a *.test.js file does not ship");
  CHECK(!shipped("web/x.config.mjs"), "a *.config.<lowercase> file does not ship");
  CHECK(shipped("web/x.configure.js"), "a name that only starts with config ships");
  CHECK(!shipped("docs/notes.md") && !shipped("ui/wire/wire.wasm"), "a non-source file does not ship");
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: no_checkpoint <repo root> [tracked files...]\n");
    return 2;
  }
  test_scan();
  test_shipped();
  const char *root = argv[1];
  int saw_db = 0, saw_gen = 0, saw_py = 0;
  for (int i = 2; i < argc; i++) {
    const char *rel = argv[i];
    if (strncmp(rel, "cbase/", 6) == 0 || strncmp(rel, "cdom/", 5) == 0) {
      failures++;
      fprintf(stderr, "FAIL %s: a submodule is listed as amgi's code\n", rel);
      continue;
    }
    if (!shipped(rel)) continue;
    if (strcmp(rel, "server/collection/db.c") == 0) saw_db = 1;
    if (strcmp(rel, "plusaudio/generate-clip.js") == 0) saw_gen = 1;
    if (strcmp(rel, "anki/addon/amgi_bridge/bridge_ops.py") == 0) saw_py = 1;
    char path[4096];
    if (snprintf(path, sizeof path, "%s/%s", root, rel) >= (int)sizeof path) {
      failures++;
      fprintf(stderr, "FAIL %s: path too long\n", rel);
      continue;
    }
    size_t n = 0;
    char *src = read_file(path, &n);
    checks++;
    if (!src) {
      failures++;
      fprintf(stderr, "FAIL %s: cannot read it\n", rel);
      continue;
    }
    char hits[8192];
    if (file_checkpoints(rel, src, n, hits, sizeof hits) > 0) {
      failures++;
      fprintf(stderr, "FAIL %s: a checkpoint in a shipped path (amgi never checkpoints a collection)\n", rel);
      for (const char *p = hits; *p;) {
        const char *nl = strchr(p, '\n');
        fprintf(stderr, "      %.*s\n", (int)(nl - p), p);
        p = nl + 1;
      }
    }
    free(src);
  }
  CHECK(saw_db, "the scan sees the C (server/collection/db.c)");
  CHECK(saw_gen, "the scan sees the JavaScript (plusaudio/generate-clip.js)");
  CHECK(saw_py, "the scan sees the Python (anki/addon/amgi_bridge/bridge_ops.py)");
  printf("no checkpoint: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
