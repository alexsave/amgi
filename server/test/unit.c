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

#include "../collection/core.h"
#include "../collection/rng.h"
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
  /* random.js's pinned draws for seed 1 (plusaudio/test/random.test.js) */
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
  snprintf(from, sizeof from, "%s/test/parity/fixtures/schema%s/collection.anki2", root, schema);
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

typedef struct { str path; int n, ok, done; } lister;
static void *list_again(void *arg) {
  lister *l = arg;
  for (int i = 0; i < l->n; i++) {
    arena a = {0};
    col_notetype *nts;
    size_t n;
    col_err e;
    if (col_list_notetypes(&a, l->path, &nts, &n, &e) == 0) l->ok++;
    ar_free(&a);
  }
  __atomic_store_n(&l->done, 1, __ATOMIC_RELEASE);
  return NULL;
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

  /* The schema is never touched: a read writes nothing (another connection sees no change), and
   * after every deck and note-type operation the schema text is what Anki wrote. */
  str s18 = fixture(&a, "18", "schema");
  sqlite3 *watch;
  sqlite3_open(s18.p, &watch);
  sqlite3_create_collation(watch, "unicase", SQLITE_UTF8, NULL, unicase_cmp);
  const char *schema_sql = "SELECT group_concat(name || ':' || coalesce(sql, ''), char(10)) FROM sqlite_master";
  char *before = NULL;
  {
    sqlite3_stmt *q;
    sqlite3_prepare_v2(watch, schema_sql, -1, &q, NULL);
    sqlite3_step(q);
    before = strdup((const char *)sqlite3_column_text(q, 0));
    sqlite3_finalize(q);
  }
  /* While a thread lists note types over and over, another connection keeps reading the schema:
   * a relax (schema rewritten to COLLATE NOCASE and back) commits, so the watcher would see it. */
  lister ls = {s18, 300, 0, 0};
  pthread_t lt;
  pthread_create(&lt, NULL, list_again, &ls);
  int relaxed_seen = 0, reads = 0;
  while (!__atomic_load_n(&ls.done, __ATOMIC_ACQUIRE)) {
    sqlite3_stmt *q;
    if (sqlite3_prepare_v2(watch, schema_sql, -1, &q, NULL) == SQLITE_OK && sqlite3_step(q) == SQLITE_ROW) {
      reads++;
      if (strstr((const char *)sqlite3_column_text(q, 0), "COLLATE NOCASE")) relaxed_seen++;
    }
    sqlite3_finalize(q);
  }
  pthread_join(lt, NULL);
  CHECK(ls.ok == 300 && reads > 0 && relaxed_seen == 0, "listing note types never rewrites the schema (%d of 300 listed, %d reads, %d saw it relaxed)", ls.ok, reads, relaxed_seen);
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
  for (int i = 0; i < 5; i++) {
    sqlite3_stmt *q;
    sqlite3_prepare_v2(watch, schema_sql, -1, &q, NULL);
    sqlite3_step(q);
    CHECK(steps[i].ok && !strcmp(before, (const char *)sqlite3_column_text(q, 0)), "after \"%s\" the schema text is Anki's", steps[i].what);
    sqlite3_finalize(q);
  }
  free(before);
  sqlite3_close(watch);

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
  char cmd[4200];
  snprintf(cmd, sizeof cmd, "rm -rf '%s'", scratch);
  if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", scratch);
  printf("unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
