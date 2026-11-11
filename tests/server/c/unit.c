/* Tests of the C collection core by itself, with no JavaScript to compare against: what the
 * format rules must answer, and the core's process state (the path lock, a real exclusive lock,
 * the backup ledger) on copies of the parity fixtures. Run by `make -C server check`, under ASan and
 * UBSan.
 *
 *   build/unit <repo root> */
#include <dirent.h>
#include <pthread.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "../../../server/collection/core.h"
#include "../../../server/collection/rng.h"
#include "wire.h"

int media_exists(cx *c, str dir, str name);
int media_read(cx *c, str dir, str name, str *out);
int wire_length_fits(size_t n);
#define AJ_MAX_DEPTH_TESTED 256

static int failures, checks;
#define CHECK(cond, ...)                         \
  do {                                           \
    checks++;                                    \
    if (!(cond)) {                               \
      failures++;                                \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);              \
      fputc('\n', stderr);                       \
    }                                            \
  } while (0)
#define CHECK_STR(got, want) CHECK(str_eq((got), str_c(want)), "got \"%.*s\", want \"%s\"", (int)(got).n, (got).p, (want))

static const char *root;
static char scratch[4096]; /* this run's temporary folder */

/* ---- the format rules ---- */
static void json_rules(void) {
  arena a = {0};
  const char *why = NULL;
  struct { const char *in, *out; } cases[] = {
    /* array-index keys first, ascending; everything else in the order first set; a repeat keeps its place */
    {"{\"b\":1,\"10\":2,\"a\":3,\"1\":4,\"1794169279580\":5,\"b\":6}", "{\"1\":4,\"10\":2,\"b\":6,\"a\":3,\"1794169279580\":5}"},
    {"{\"4294967295\":1,\"4294967294\":2,\"01\":3}", "{\"4294967294\":2,\"4294967295\":1,\"01\":3}"},
    {"[1.50,-0,1e21,1E-7,0.1,123456789012345680000,1e-6]", "[1.5,0,1e+21,1e-7,0.1,123456789012345680000,0.000001]"},
    {"\"\\ud83d\\ude00 \\ud800 \\u001f\\u007f \\/\"", "\"\xf0\x9f\x98\x80 \\ud800 \\u001f\x7f /\""},
    {" {\n\t\"x\" : [ ] , \"y\":{}}\r", "{\"x\":[],\"y\":{}}"},
    {"1e400", "null"},
  };
  for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
    aj *v = anki_json_parse(&a, str_c(cases[i].in), &why);
    CHECK(v != NULL, "parses %s", cases[i].in);
    if (v) CHECK_STR(anki_json_stringify(&a, v), cases[i].out);
  }
  const char *bad[] = {"{\"a\":1", "{\"a\":1}x", "[1,]", "{a:1}", "\"\x01\"", "01", "-", ""};
  for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) CHECK(!anki_json_parse(&a, str_c(bad[i]), &why), "refuses %s", bad[i]);
  aj *o = anki_json_parse(&a, S("{\"a\":1,\"b\":2}"), &why);
  aj_set(&a, o, S("a"), aj_num(&a, 9));
  aj_set(&a, o, S("c"), aj_bool(&a, 1));
  aj_del(o, S("b"));
  CHECK_STR(anki_json_stringify(&a, o), "{\"a\":9,\"c\":true}");
  ar_free(&a);
}

static void text_rules(void) {
  arena a = {0};
  /* WHATWG decoding: a maximal subpart at a time */
  struct { const char *in; size_t n; const char *out; } u[] = {
    {"a\xc3\x28" "b", 4, "a\xef\xbf\xbd(b"}, {"\xe2\x82", 2, "\xef\xbf\xbd"}, {"\xed\xa0\x80", 3, "\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd"},
    {"\xf0\x9f\x98\x80", 4, "\xf0\x9f\x98\x80"}, {"\xff", 1, "\xef\xbf\xbd"}, {"\xc0\xaf", 2, "\xef\xbf\xbd\xef\xbf\xbd"},
  };
  for (size_t i = 0; i < sizeof u / sizeof *u; i++) CHECK_STR(utf8_clean(&a, (str){u[i].in, u[i].n}), u[i].out);
  CHECK_STR(js_trim(str_c("\xe3\x80\x80 \t\xef\xbb\xbfx y\xc2\xa0\n")), "x y");
  CHECK_STR(js_lower(&a, str_c("ΣΑΣ İ")), "σας i\xcc\x87");
  CHECK_STR(js_nfc(&a, str_c("e\xcc\x81")), "\xc3\xa9");
  struct { double v; const char *s; } n[] = {{1, "1"}, {-0.0, "0"}, {1e21, "1e+21"}, {1e-7, "1e-7"}, {0.1, "0.1"}, {123.456, "123.456"},
                                             {1794169279580, "1794169279580"}, {0.000001, "0.000001"}, {5e-324, "5e-324"}};
  for (size_t i = 0; i < sizeof n / sizeof *n; i++) {
    buf b = {0};
    js_num(&b, n[i].v);
    CHECK_STR(buf_str(&a, &b), n[i].s);
    buf_free(&b);
  }
  cx c = {&a, NULL, {0}};
  CHECK_STR(strip_html_preserving_media(&c, str_c("<b>Hi</b> &amp; <img src=\"pic.png\"> &#x41;&nbsp;x <!-- c --> <IMG SRC=bare.jpg>")),
            "Hi &  pic.png  A x   bare.jpg ");
  CHECK_STR(strip_html_preserving_media(&c, str_c("&#xD83D;&#xDE00; &#xD83D;")), "\xf0\x9f\x98\x80 \xef\xbf\xbd");
  str fields[] = {S("a\x1f" "b"), S("cr\r\nlf\t\x7f"), S("cafe\xcc\x81")};
  str *af = anki_fields(&c, fields, 3);
  CHECK_STR(af[0], "ab");
  CHECK_STR(af[1], "cr\nlf\t");
  CHECK_STR(af[2], "caf\xc3\xa9");
  CHECK(field_checksum(&c, S("existing one")) == 3521495218, "the checksum of a fixture note, as Anki stored it");
  CHECK(looks_romanized(&c, S("annyeong"), S("ko")) && !looks_romanized(&c, S("안녕 still"), S("KO")) &&
          !looks_romanized(&c, S("hola"), S("es")), "the romanisation guard");
  /* random.js's pinned draws for seed 1 (tests/server/plusaudio/random.test.js) */
  rng r;
  rng_seed(&r, 1);
  uint32_t want[] = {1828152527, 3394835397u, 2967886022u, 2251045104u};
  for (int i = 0; i < 4; i++) CHECK(rng_next(&r) == want[i], "draw %d of seed 1", i);
  /* The OS seed uses every one of its 16 bytes: two that differ only past the fourth differ. */
  uint8_t e1[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}, e2[16];
  memcpy(e2, e1, 16);
  e2[15] ^= 0x80;
  rng r1, r2;
  rng_seed_entropy(&r1, e1);
  rng_seed_entropy(&r2, e2);
  int differ = 0;
  for (int i = 0; i < 4; i++) differ |= rng_next(&r1) != rng_next(&r2);
  CHECK(differ, "an OS seed of 16 bytes draws differently when only its last byte differs");
  CHECK_STR(path_join(&a, S("/m/collection.media"), S("../clip.ogg")), "/m/clip.ogg");
  /* A bare file name's folder is ".", one byte (a collection opened by a relative name puts its
   * backups beside it). */
  CHECK_STR(path_dirname(&a, S("collection.anki2")), ".");
  CHECK_STR(path_dirname(&a, S("/collection.anki2")), "/");
  CHECK_STR(path_join(&a, path_dirname(&a, S("collection.anki2")), S("amgi-collection-backups")), "amgi-collection-backups");
  CHECK_STR(path_extname(S("a.b.")), ".");
  CHECK_STR(path_extname(S(".hidden")), "");
  ar_free(&a);
}

/* ---- hostile protobuf: a varint past ten bytes, a skip that would run past the end ---- */
typedef struct { const unsigned char *p; size_t n; uint64_t wanted; int fields; } pb_case;
static void pb_walk(cx *c, void *arg) {
  pb_case *k = arg;
  size_t at = 0;
  pb_field f;
  k->fields = 0;
  while (pb_next(c, k->p, k->n, &at, k->wanted, &f)) {
    k->fields++;
    if (at > k->n) cx_throw(c, NULL, 0, "read past the end (%zu of %zu)", at, k->n);
  }
}
static void pb_rules(void) {
  arena a = {0};
  unsigned char long_tag[160], long_value[160], skip_end[3] = {0x08, 0x80, 0x80};
  memset(long_tag, 0x80, sizeof long_tag);
  long_tag[sizeof long_tag - 1] = 0x01;
  long_value[0] = 0x08;
  memset(long_value + 1, 0x80, sizeof long_value - 2);
  long_value[sizeof long_value - 1] = 0x01;
  unsigned char eleven[12] = {0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00};
  unsigned char ok[] = {0x08, 0x96, 0x01, 0x12, 0x02, 'h', 'i', 0x10, 0xff, 0xff, 0xff, 0xff, 0x0f};
  struct { const unsigned char *p; size_t n; uint64_t wanted; const char *want; int fields; } cases[] = {
    {long_tag, sizeof long_tag, 0, "protobuf varint is too large to read exactly", 0},
    {long_value, sizeof long_value, 1u << 1, "protobuf varint is too large to read exactly", 0},
    {eleven, sizeof eleven, 1u << 1, "protobuf varint is too large to read exactly", 0},
    {skip_end, sizeof skip_end, 0, NULL, 1},
    {ok, sizeof ok, (1u << 1) | (1u << 2), NULL, 3},
  };
  for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
    cx c = {&a, NULL, {0}};
    pb_case k = {cases[i].p, cases[i].n, cases[i].wanted, 0};
    int threw = cx_try(&c, pb_walk, &k) < 0;
    if (cases[i].want)
      CHECK(threw && str_eq_c(c.err.message, cases[i].want), "pb case %zu throws \"%s\" (got %.*s)", i, cases[i].want,
            threw ? (int)c.err.message.n : 2, threw ? c.err.message.p : "ok");
    else
      CHECK(!threw && k.fields == cases[i].fields, "pb case %zu reads %d fields and stays in bounds (%s)", i, cases[i].fields,
            threw ? c.err.message.p : "ok");
  }
  ar_free(&a);
}

/* ---- JSON nesting: refused past the limit, and the limit parsed on a small thread stack ---- */
typedef struct { int depth; int parsed; } nest_case;
static void *parse_nested(void *arg) {
  nest_case *k = arg;
  arena a = {0};
  buf b = {0};
  for (int i = 0; i < k->depth; i++) buf_ch(&b, '[');
  for (int i = 0; i < k->depth; i++) buf_ch(&b, ']');
  const char *why = NULL;
  k->parsed = anki_json_parse(&a, (str){b.p, b.n}, &why) != NULL;
  buf_free(&b);
  ar_free(&a);
  return NULL;
}
static void json_depth(void) {
  /* A server thread's stack is the platform's default, 512 KiB on macOS; half of it here. */
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 256 * 1024);
  struct { int depth, want; } cases[] = {{AJ_MAX_DEPTH_TESTED, 1}, {AJ_MAX_DEPTH_TESTED + 1, 0}, {100000, 0}};
  for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
    nest_case k = {cases[i].depth, -1};
    pthread_t t;
    pthread_create(&t, &attr, parse_nested, &k);
    pthread_join(t, NULL);
    CHECK(k.parsed == cases[i].want, "JSON nested %d deep %s on a 256 KiB stack", cases[i].depth, cases[i].want ? "parses" : "is refused");
  }
  pthread_attr_destroy(&attr);
  CHECK(wire_length_fits(0xffffffffu) && !wire_length_fits((size_t)0xffffffffu + 1), "a wire message's length must fit its u32");
}

/* ---- the media folder: no symlink followed, nothing but a regular file read, hostile names refused ---- */
static void media_files(void) {
  arena a = {0};
  char dir[4096], outside[4096], link[4096], fifo[4096], plain[4096];
  snprintf(dir, sizeof dir, "%s/media-test.media", scratch);
  mkdir(dir, 0777);
  snprintf(outside, sizeof outside, "%s/secret.txt", scratch);
  FILE *f = fopen(outside, "w");
  fputs("outside the media folder", f);
  fclose(f);
  snprintf(plain, sizeof plain, "%s/clip.wav", dir);
  f = fopen(plain, "w");
  fputs("a clip", f);
  fclose(f);
  snprintf(link, sizeof link, "%s/link.wav", dir);
  if (symlink(outside, link) != 0) perror("symlink");
  snprintf(fifo, sizeof fifo, "%s/fifo.wav", dir);
  if (mkfifo(fifo, 0600) != 0) perror("mkfifo");
  cx c = {&a, NULL, {0}};
  str d = str_c(dir), out;
  CHECK(media_read(&c, d, S("clip.wav"), &out) && str_eq_c(out, "a clip"), "a clip is read");
  CHECK(!media_read(&c, d, S("link.wav"), &out), "a symlink out of the folder is not followed");
  CHECK(!media_read(&c, d, S("fifo.wav"), &out), "a FIFO is not read (and does not hang)");
  CHECK(media_exists(&c, d, S("clip.wav")), "hasMedia finds a clip");
  const char *hostile[] = {"../collection.anki2", "a/b", "a\\b", "..", ".", ""};
  for (size_t i = 0; i < sizeof hostile / sizeof *hostile; i++)
    CHECK(!media_exists(&c, d, str_c(hostile[i])), "hasMedia refuses \"%s\"", hostile[i]);
  ar_free(&a);
}

/* ---- the core on a fixture copy ---- */

static void copy_file(const char *from, const char *to) {
  FILE *in = fopen(from, "rb"), *out = fopen(to, "wb");
  if (!in || !out) {
    fprintf(stderr, "copy %s -> %s failed\n", from, to);
    exit(2);
  }
  char chunk[1 << 16];
  size_t n;
  while ((n = fread(chunk, 1, sizeof chunk, in)) > 0) fwrite(chunk, 1, n, out);
  fclose(in);
  fclose(out);
}

static str fixture(arena *a, const char *schema, const char *name) {
  char dir[4096];
  snprintf(dir, sizeof dir, "%s/%s", scratch, name);
  mkdir(dir, 0777);
  char from[4096], to[4096];
  snprintf(from, sizeof from, "%s/tests/server/parity/fixtures/schema%s/collection.anki2", root, schema);
  snprintf(to, sizeof to, "%s/collection.anki2", dir);
  copy_file(from, to);
  return str_c(ar_dup(a, to, strlen(to)));
}

static size_t count_backups(const char *collection) {
  char dir[4096];
  snprintf(dir, sizeof dir, "%.*s/amgi-collection-backups", (int)(strrchr(collection, '/') - collection), collection);
  DIR *d = opendir(dir);
  if (!d) return 0;
  size_t n = 0;
  struct dirent *e;
  while ((e = readdir(d)))
    if (e->d_name[0] != '.') n++;
  closedir(d);
  return n;
}

typedef struct { str path; int ok; col_err err; } adder;
static void *add_one(void *arg) {
  adder *ad = arg;
  arena a = {0};
  str fields[] = {S("parallel"), S("x")};
  col_new_note note = {1, 0, fields, 2, NULL, 0, 0, {0}, 0, 0};
  col_notetype *nts;
  size_t n;
  col_err e;
  if (col_list_notetypes(&a, ad->path, &nts, &n, &e) == 0) {
    for (size_t i = 0; i < n; i++)
      if (str_eq_c(nts[i].name, "Basic")) note.notetype_id = (double)nts[i].id;
    col_added r;
    ad->ok = col_add_note(&a, ad->path, &note, &r, &ad->err) == 0;
    if (!ad->ok) ad->err.message = (str){NULL, 0}; /* the arena goes */
  }
  ar_free(&a);
  return NULL;
}

/* ---- the collection file is only opened when it is safe to (incident-1842) ---- */
/* The whole of a file, or {NULL, 0} when there is none. */
static str slurp(arena *a, const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return (str){NULL, 0};
  buf b = {0};
  char chunk[1 << 16];
  size_t n;
  while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) buf_put(&b, chunk, n);
  fclose(f);
  str out = b.n ? buf_str(a, &b) : (str){ar_dup(a, "", 0), 0};
  buf_free(&b);
  return out;
}
static int same_file(arena *a, const char *path, str was) {
  str now = slurp(a, path);
  return (now.p == NULL) == (was.p == NULL) && (!now.p || str_eq(now, was));
}
static int exists(const char *path) {
  struct stat sb;
  return stat(path, &sb) == 0;
}
/* collection.anki2, -wal and -shm as they are now. */
typedef struct { char main[4200], wal[4200], shm[4200], dir[4200]; str m, w, s; } files;
static void snapshot(arena *a, str path, files *f) {
  snprintf(f->main, sizeof f->main, "%s", path.p);
  snprintf(f->wal, sizeof f->wal, "%s-wal", path.p);
  snprintf(f->shm, sizeof f->shm, "%s-shm", path.p);
  snprintf(f->dir, sizeof f->dir, "%.*s", (int)(strrchr(path.p, '/') - path.p), path.p);
  f->m = slurp(a, f->main), f->w = slurp(a, f->wal), f->s = slurp(a, f->shm);
}
static int unchanged(arena *a, const files *f) {
  return same_file(a, f->main, f->m) && same_file(a, f->wal, f->w) && same_file(a, f->shm, f->s);
}
/* sqlite_master's text, on a connection of its own that is closed again. */
static char *schema_text(const char *path) {
  sqlite3 *db;
  sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL); /* read-write: its close removes the -wal and -shm it made */
  sqlite3_stmt *q;
  sqlite3_prepare_v2(db, "SELECT group_concat(name || ':' || coalesce(sql, ''), char(10)) FROM sqlite_master", -1, &q, NULL);
  char *out = sqlite3_step(q) == SQLITE_ROW ? strdup((const char *)sqlite3_column_text(q, 0)) : strdup("(none)");
  sqlite3_finalize(q);
  sqlite3_close(db);
  return out;
}

static void core_state(void) {
  arena a = {0};
  /* Concurrent writers in one process all land: the path lock orders them. */
  str path = fixture(&a, "18", "parallel");
  adder ads[16];
  pthread_t th[16];
  for (int i = 0; i < 16; i++) {
    ads[i] = (adder){path, 0, {0}};
    pthread_create(&th[i], NULL, add_one, &ads[i]);
  }
  int all = 1;
  for (int i = 0; i < 16; i++) {
    pthread_join(th[i], NULL);
    all &= ads[i].ok;
  }
  CHECK(all, "sixteen concurrent adds all land");
  int64_t count;
  col_err e;
  CHECK(col_count_notes(&a, path, 1, &count, &e) == 0 && count == 16, "and are all there (%lld)", (long long)count);
  CHECK(count_backups(path.p) == 1, "one backup for all of them (%zu)", count_backups(path.p));

  /* A collection another connection holds the way Anki does: locked, and nothing copied. */
  str held = fixture(&a, "18", "held");
  sqlite3 *anki;
  sqlite3_open(held.p, &anki);
  sqlite3_exec(anki, "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN; UPDATE col SET usn = usn; COMMIT;", NULL, NULL, NULL);
  col_state st = {"(none)", 0};
  CHECK(col_status(&a, held, &st, &e) == 0 && !strcmp(st.status, "locked"), "status says locked (%s)", st.status);
  col_deck_made made;
  CHECK(col_create_deck(&a, held, S("While held"), &made, &e) < 0 && e.kind && !strcmp(e.kind, "locked") &&
          str_eq_c(e.message, "collection is locked"),
        "a write is refused as locked");
  CHECK(count_backups(held.p) == 0, "and nothing was copied");
  /* Every op that threw gave its path's ticket back: one more on the same path still runs (it would
   * wait for ever otherwise). */
  for (int i = 0; i < 5; i++) col_create_deck(&a, held, S("Still held"), &made, &e);
  sqlite3_close(anki);
  CHECK(col_status(&a, held, &st, &e) == 0 && !strcmp(st.status, "ok") && st.schema == 18, "released: ok again");

  /* addMedia changes the collection's folder, so it backs the collection up first like any write. */
  str med = fixture(&a, "18", "media-first");
  str stored;
  CHECK(col_add_media(&a, med, S("clip.ogg"), "ogg", 3, &stored, &e) == 0, "a media file");
  CHECK(count_backups(med.p) == 1, "the first write of the session, so one backup (%zu)", count_backups(med.p));

  /* The ledger: one backup per session, another after somebody else's change, then none. */
  str led = fixture(&a, "11", "ledger");
  CHECK(col_create_deck(&a, led, S("Ours 1"), &made, &e) == 0 && made.created, "a deck");
  CHECK(col_create_deck(&a, led, S("Ours 2"), &made, &e) == 0, "another");
  CHECK(count_backups(led.p) == 1, "one backup (%zu)", count_backups(led.p));
  sqlite3 *other;
  sqlite3_open(led.p, &other);
  sqlite3_exec(other, "UPDATE col SET mod = mod + 1", NULL, NULL, NULL);
  sqlite3_close(other);
  CHECK(col_create_deck(&a, led, S("Ours 3"), &made, &e) == 0, "after their change");
  CHECK(col_create_deck(&a, led, S("Ours 4"), &made, &e) == 0, "and after ours");
  CHECK(count_backups(led.p) == 2, "a second backup, and only one (%zu)", count_backups(led.p));
  CHECK(col_remove_deck(&a, led, 1, &(col_removal){0}, &e) < 0 && e.status == 400, "the Default deck is refused, 400");

  /* The schema is never touched: a read writes nothing (the file is byte for byte as it was, now
   * that no open checkpoints), and after every deck and note-type operation the schema text is what
   * Anki wrote. Each look is a connection of its own, opened and closed: one held open beside the
   * collection would make it locked to amgi (incident-1842). */
  str s18 = fixture(&a, "18", "schema");
  char *before = schema_text(s18.p);
  str bytes_before = slurp(&a, s18.p);
  int listed = 0;
  for (int i = 0; i < 300; i++) {
    col_notetype *nl;
    size_t nn;
    listed += col_list_notetypes(&a, s18, &nl, &nn, &e) == 0;
  }
  CHECK(listed == 300 && same_file(&a, s18.p, bytes_before), "listing note types 300 times writes nothing (%d listed)", listed);
  col_notetype *nts;
  size_t nnt;
  col_deck_made dm;
  col_renamed rn;
  col_removal rm;
  str fields[] = {S("Front"), S("Back")};
  col_spec_template tmpl = {S("Card 1"), S("{{Front}}"), S("{{Back}}")};
  col_spec spec = {S("Ünicase type"), fields, 2, &tmpl, 1, S(".card {}"), NULL, 0};
  col_notetype_made ntm;
  struct { const char *what; int ok; } steps[5];
  steps[0] = (typeof(steps[0])){"create Äpfel::Öl", col_create_deck(&a, s18, S("Äpfel::Öl"), &dm, &e) == 0};
  int64_t made_id = dm.id;
  steps[1] = (typeof(steps[0])){"rename it to äpfel::ÖL 2", col_rename_deck(&a, s18, (double)made_id, S("äpfel::ÖL 2"), &rn, &e) == 0};
  steps[2] = (typeof(steps[0])){"create a note type", col_create_notetype(&a, s18, &spec, NULL, 0, &ntm, &e) == 0};
  steps[3] = (typeof(steps[0])){"remove the deck", col_remove_deck(&a, s18, (double)made_id, &rm, &e) == 0};
  steps[4] = (typeof(steps[0])){"list note types", col_list_notetypes(&a, s18, &nts, &nnt, &e) == 0};
  char *after = schema_text(s18.p);
  for (int i = 0; i < 5; i++) CHECK(steps[i].ok, "\"%s\"", steps[i].what);
  CHECK(!strcmp(before, after), "after them all the schema text is Anki's");
  free(before);
  free(after);

  /* Names that differ only by case, as unicase (Anki's collation) folds them: the same deck, never a
   * second row the unique index would refuse. */
  str uc = fixture(&a, "18", "unicase");
  col_deck_made d1, d2;
  struct { const char *first, *second; } same[] = {{"Straße", "STRASSE"}, {"Äpfel", "äPFEL"}, {"ǅ", "ǆ"}, {"ﬁ", "FI"}};
  for (size_t i = 0; i < sizeof same / sizeof *same; i++) {
    int ok1 = col_create_deck(&a, uc, str_c(same[i].first), &d1, &e) == 0;
    int ok2 = col_create_deck(&a, uc, str_c(same[i].second), &d2, &e) == 0;
    CHECK(ok1 && ok2 && d1.created && !d2.created && d1.id == d2.id, "\"%s\" finds \"%s\" as Anki does (%.*s)", same[i].second,
          same[i].first, ok2 ? 2 : (int)e.message.n, ok2 ? "ok" : e.message.p);
  }
  /* A deck renamed under a parent spelled like its own old name: the parent is made, as Anki makes
   * it (the deck being renamed is not its own parent). */
  col_deck_made ap;
  col_renamed apr;
  col_deck *dl;
  size_t ndl;
  int parent = 0;
  if (col_create_deck(&a, uc, S("Birne"), &ap, &e) == 0 && col_rename_deck(&a, uc, (double)ap.id, S("BIRNE::Öl"), &apr, &e) == 0 &&
      col_list_decks(&a, uc, &dl, &ndl, &e) == 0)
    for (size_t i = 0; i < ndl; i++) parent |= str_eq_c(dl[i].name, "BIRNE");
  CHECK(parent, "renaming Birne to BIRNE::Öl makes its parent BIRNE");
  /* And the one Anki's collation does not call equal: its fold of U+FB03 is "iff", not "ffi". */
  int lig = col_create_deck(&a, uc, S("ﬃ"), &d1, &e) == 0, ffi = col_create_deck(&a, uc, S("FFI"), &d2, &e) == 0;
  CHECK(lig && ffi && d1.created && d2.created && d1.id != d2.id, "\"FFI\" is not \"ﬃ\", as Anki says");
  ar_free(&a);
}

/* ---- atomic writes: a write that fails part way leaves nothing of itself ---- */
static int64_t scalar(const char *path, const char *sql) {
  sqlite3 *db;
  sqlite3_open(path, &db);
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, NULL, unicase_cmp);
  sqlite3_stmt *q;
  int64_t v = -1;
  if (sqlite3_prepare_v2(db, sql, -1, &q, NULL) == SQLITE_OK && sqlite3_step(q) == SQLITE_ROW) v = sqlite3_column_int64(q, 0);
  sqlite3_finalize(q);
  sqlite3_close(db);
  return v;
}
static void exec_sql(const char *path, const char *sql) {
  sqlite3 *db;
  sqlite3_open(path, &db);
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, NULL, unicase_cmp);
  char *err = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) fprintf(stderr, "exec_sql: %s\n", err);
  sqlite3_free(err);
  sqlite3_close(db);
}

static void atomic_writes(void) {
  arena a = {0};
  col_err e;
  for (int schema = 18; schema >= 11; schema -= 7) {
    str path = fixture(&a, schema == 18 ? "18" : "11", schema == 18 ? "atomic18" : "atomic11");
    /* A card of ordinal 1 is refused: a reversed note's second card fails after its note and
     * first card went in. */
    exec_sql(path.p, "CREATE TRIGGER refuse_second_card BEFORE INSERT ON cards WHEN NEW.ord = 1 BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    col_notetype *nts;
    size_t nnt;
    col_list_notetypes(&a, path, &nts, &nnt, &e);
    double basic = 0, reversed = 0;
    for (size_t i = 0; i < nnt; i++) {
      if (str_eq_c(nts[i].name, "Basic")) basic = (double)nts[i].id;
      if (str_eq_c(nts[i].name, "Basic (and reversed card)")) reversed = (double)nts[i].id;
    }
    int64_t notes0 = scalar(path.p, "SELECT count(*) FROM notes"), cards0 = scalar(path.p, "SELECT count(*) FROM cards");
    int64_t mod0 = scalar(path.p, "SELECT mod FROM col");
    str two[] = {S("front"), S("back")};
    col_new_note rev = {1, reversed, two, 2, NULL, 0, 0, {0}, 0, 0};
    col_added r;
    CHECK(col_add_note(&a, path, &rev, &r, &e) < 0, "schema %d: the second card is refused", schema);
    CHECK(scalar(path.p, "SELECT count(*) FROM notes") == notes0 && scalar(path.p, "SELECT count(*) FROM cards") == cards0 &&
            scalar(path.p, "SELECT mod FROM col") == mod0,
          "schema %d: a note whose cards fail leaves no note, no card and no col.mod change", schema);
    /* In a bulk add the failing note goes and the others stay. */
    col_new_note batch[3] = {{1, basic, two, 2, NULL, 0, 0, {0}, 0, 0}, rev, {1, basic, two, 2, NULL, 0, 0, {0}, 0, 0}};
    col_added out[3];
    CHECK(col_add_notes(&a, path, batch, 3, out, &e) == 0 && out[0].ok && !out[1].ok && out[2].ok, "schema %d: bulk: the bad note alone fails", schema);
    CHECK(scalar(path.p, "SELECT count(*) FROM notes") == notes0 + 2 && scalar(path.p, "SELECT count(*) FROM cards") == cards0 + 2,
          "schema %d: bulk: two notes and two cards, nothing of the third", schema);
    /* A rename whose second row fails renames nothing. */
    col_deck_made parent, child;
    col_create_deck(&a, path, S("Atomic"), &parent, &e);
    col_create_deck(&a, path, S("Atomic::Child"), &child, &e);
    if (schema == 18) {
      exec_sql(path.p, "CREATE TRIGGER refuse_child BEFORE UPDATE ON decks WHEN NEW.name LIKE '%Child' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
      col_renamed rn;
      CHECK(col_rename_deck(&a, path, (double)parent.id, S("Moved"), &rn, &e) < 0, "schema 18: the child's rename is refused");
      CHECK(scalar(path.p, "SELECT count(*) FROM decks WHERE name = 'Atomic'") == 1, "schema 18: so the parent is not renamed either");
    }
  }
  ar_free(&a);
}

/* Anki's leftover: one committed change in a -wal the close did not fold back (no -shm, as Anki's
 * exclusive connection keeps its index in memory). */
static void leave_wal(str path) {
  sqlite3 *db;
  sqlite3_open(path.p, &db);
  sqlite3_db_config(db, SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, 1, NULL);
  sqlite3_exec(db, "PRAGMA journal_mode = WAL; UPDATE col SET mod = mod + 1", NULL, NULL, NULL);
  sqlite3_close(db);
  char shm[4200];
  snprintf(shm, sizeof shm, "%s-shm", path.p);
  unlink(shm);
}
/* Every op the core has, each refused with this kind; and then nothing on disk changed. */
static void all_refused(arena *a, str path, const char *kind, const char *message, const char *what) {
  files f;
  snapshot(a, path, &f);
  col_err e;
  col_state st = {"(none)", 0};
  CHECK(col_status(a, path, &st, &e) == 0 && !strcmp(st.status, kind), "%s: status says %s (%s)", what, kind, st.status);
  col_deck *d;
  size_t nd;
  memset(&e, 0, sizeof e);
  CHECK(col_list_decks(a, path, &d, &nd, &e) < 0 && e.kind && !strcmp(e.kind, kind) && str_eq_c(e.message, message),
        "%s: a read is refused (%s: %.*s)", what, e.kind ? e.kind : "-", (int)e.message.n, e.message.p);
  col_deck_made made;
  memset(&e, 0, sizeof e);
  CHECK(col_create_deck(a, path, S("Never"), &made, &e) < 0 && e.kind && !strcmp(e.kind, kind), "%s: a write is refused", what);
  CHECK(unchanged(a, &f), "%s: collection.anki2, its -wal and its -shm are byte for byte as they were", what);
  CHECK(count_backups(path.p) == 0, "%s: no backup taken", what);
}

static void collection_safety(void) {
  arena a = {0};
  const char *damaged = "the collection file is damaged; amgi did not open it";
  /* Lane D's shape: a main that is zero for its whole length (58 pages) beside a short -wal. Any
   * SQLite open of it fails, and its close then checkpoints that -wal, the only good copy of the
   * newest pages, into the zeros and deletes it. amgi checks the header first and never opens it. */
  str zero = fixture(&a, "18", "zero-main");
  leave_wal(zero);
  char wal[4200];
  snprintf(wal, sizeof wal, "%s-wal", zero.p);
  CHECK(exists(wal), "the leftover -wal is there");
  FILE *z = fopen(zero.p, "wb");
  static const char page[4096];
  for (int i = 0; i < 58; i++) fwrite(page, 1, sizeof page, z);
  fclose(z);
  all_refused(&a, zero, "damaged", damaged, "zeroed main and a -wal");
  files f;
  snapshot(&a, zero, &f);
  col_err e = {0};
  str stored;
  CHECK(col_add_media(&a, zero, S("clip.ogg"), "ogg", 3, &stored, &e) < 0 && e.kind && !strcmp(e.kind, "damaged"), "addMedia is refused too");
  char media[4300];
  snprintf(media, sizeof media, "%s/collection.media", f.dir);
  CHECK(!exists(media) && unchanged(&a, &f), "and wrote nothing");
  /* The same without a -wal, and a file too short to have a header. */
  str bare = fixture(&a, "18", "zero-bare");
  z = fopen(bare.p, "wb");
  for (int i = 0; i < 58; i++) fwrite(page, 1, sizeof page, z);
  fclose(z);
  all_refused(&a, bare, "damaged", damaged, "zeroed main");
  str tiny = fixture(&a, "18", "tiny");
  z = fopen(tiny.p, "wb");
  fwrite("SQLite format", 1, 13, z);
  fclose(z);
  all_refused(&a, tiny, "damaged", damaged, "13 bytes");

  /* incident-1842: a -wal (or -shm) beside the collection means Anki has it open, or left it open.
   * Anki's backup-on-close drops its exclusive lock while it still writes that -wal, so the lock
   * cannot be trusted: amgi does not open the file at all, and answers locked. */
  str left = fixture(&a, "18", "leftover-wal");
  leave_wal(left);
  all_refused(&a, left, "locked", "collection is locked", "a leftover -wal");
  str shm_only = fixture(&a, "18", "leftover-shm");
  char shm[4200];
  snprintf(shm, sizeof shm, "%s-shm", shm_only.p);
  fclose(fopen(shm, "wb"));
  all_refused(&a, shm_only, "locked", "collection is locked", "a leftover -shm");

  /* A healthy, closed collection: a status probe and a read change nothing and leave nothing; a
   * write leaves no -wal or -shm behind. */
  str clean = fixture(&a, "18", "clean");
  snapshot(&a, clean, &f);
  col_state st = {"(none)", 0};
  col_deck *d;
  size_t nd;
  CHECK(col_status(&a, clean, &st, &e) == 0 && !strcmp(st.status, "ok"), "a clean collection is ok");
  CHECK(col_list_decks(&a, clean, &d, &nd, &e) == 0 && nd > 0, "and reads");
  CHECK(unchanged(&a, &f), "a status probe and a read leave collection.anki2 byte for byte as it was, and no -wal or -shm");
  col_deck_made made;
  CHECK(col_create_deck(&a, clean, S("Written"), &made, &e) == 0 && made.created, "a write");
  CHECK(!exists(f.wal) && !exists(f.shm), "leaves no -wal or -shm");
  CHECK(col_status(&a, clean, &st, &e) == 0 && !strcmp(st.status, "ok"), "so the next op opens it");

  /* The automatic install's write (a new note type) always has a backup of its own, but only one:
   * after a deck made earlier in the session (which took the session's backup) it takes another;
   * as the session's first write, the one with_write takes is it; a note type that is already
   * there writes nothing and copies nothing. */
  str fields[] = {S("Front"), S("Back")};
  col_spec_template tmpl = {S("Card 1"), S("{{Front}}"), S("{{Back}}")};
  col_spec spec = {S("Automatic type"), fields, 2, &tmpl, 1, S(".card {}"), NULL, 0};
  col_notetype_made ntm;
  str inst = fixture(&a, "18", "install-after");
  CHECK(col_create_deck(&a, inst, S("First"), &made, &e) == 0 && count_backups(inst.p) == 1, "a deck: the session's backup");
  CHECK(col_create_notetype(&a, inst, &spec, NULL, 0, &ntm, &e) == 0 && ntm.created, "the note type is made");
  CHECK(count_backups(inst.p) == 2, "with a backup of its own (%zu)", count_backups(inst.p));
  CHECK(col_create_notetype(&a, inst, &spec, NULL, 0, &ntm, &e) == 0 && !ntm.created, "again: it is there");
  CHECK(count_backups(inst.p) == 2, "and nothing is copied (%zu)", count_backups(inst.p));
  str first = fixture(&a, "18", "install-first");
  CHECK(col_create_notetype(&a, first, &spec, NULL, 0, &ntm, &e) == 0 && ntm.created, "the session's first write is the note type");
  CHECK(count_backups(first.p) == 1, "one backup, not two (%zu)", count_backups(first.p));
  ar_free(&a);
}

int main(int argc, char **argv) {
  root = argc > 1 ? argv[1] : "..";
  const char *tmp = getenv("TMPDIR");
  snprintf(scratch, sizeof scratch, "%s/amgi-unit-XXXXXX", tmp && *tmp ? tmp : "/tmp");
  if (!mkdtemp(scratch)) {
    perror("mkdtemp");
    return 2;
  }
  json_rules();
  pb_rules();
  text_rules();
  core_state();
  json_depth();
  atomic_writes();
  media_files();
  collection_safety();
  char cmd[4200];
  snprintf(cmd, sizeof cmd, "rm -rf '%s'", scratch);
  if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", scratch);
  printf("unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
