/* Tests of the amgi app's own C (server/amgi), built under ASan and UBSan (make -C server check-app,
 * run by npm test). The routes themselves are proven over HTTP by tests/server/parity/http.test.mjs; this
 * holds what HTTP cannot reach, or cannot reach exactly:
 *   - the rate gate (gate.c), tests/server/plusaudio/rateGate.test.js case for case, on a fake clock and a
 *     seeded draw: the 429 block and its doubling to the cap, Google's retryDelay as its floor, the
 *     learned per-minute cap and its growth, the jitter and its replay, one draw per call, admission;
 *   - the request helpers (web.c): decodeURIComponent, URLSearchParams.get, Number();
 *   - the Gemini pieces with no server: the daily-cap sentences, PCM to WAV, the audio type rules,
 *     the request's protobuf, a response's text.
 * Each check prints on failure; the exit status is the number that failed. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../server/amgi/amgi.h"
#include "../../../server/amgi/cards.h"
#include "../../../server/amgi/gate.h"
#include "../../../server/amgi/gemini.h"
#include "../../../server/collection/rng.h"
#include "../../../ui/wire/lang.h"

static int failures, checks;
#define CHECK(cond, ...)                         \
  do {                                           \
    checks++;                                    \
    if (!(cond)) {                               \
      failures++;                                \
      fprintf(stderr, "%s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);              \
      fputc('\n', stderr);                       \
    }                                            \
  } while (0)
#define STR_IS(s, lit) (str_eq_c((s), (lit)))

/* ---- the gate on a fake clock and random.js's seeded generator ---- */
typedef struct {
  int64_t t;
  rng r;
  int draws;
  int fixed; /* draw n-1 of n: the test of how many draws there are */
} fake;
static int64_t fake_now(void *ud) { return ((fake *)ud)->t; }
static uint32_t fake_draw(void *ud) {
  fake *f = ud;
  f->draws++;
  return f->fixed ? 0xffffffffu : rng_next(&f->r);
}
static gate *gate_at(fake *f, int64_t start, uint32_t seed) {
  memset(f, 0, sizeof *f);
  f->t = start;
  rng_seed(&f->r, seed);
  return gate_new(fake_now, fake_draw, f);
}
#define M "gemini-3.8-flash-tts"
static int admit(gate *g, fake *f, int n) {
  int admitted = 0;
  for (int i = 0; i < n; i++) {
    if (gate_acquire(g, M) == 0) admitted++;
    f->t += 1000;
  }
  return admitted;
}

static void test_gate(void) {
  fake f;
  gate *g = gate_at(&f, 1000000, 1);
  CHECK(admit(g, &f, 50) == 50, "an unknown limit admits everything until the first 429");
  CHECK(gate_inspect(g, M).cap == GATE_NO_CAP, "no cap learned yet");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  admit(g, &f, 10);
  gate_acquire(g, M);
  gate_record(g, M, 1, 5000);
  CHECK(gate_inspect(g, M).cap == 8, "80%% of the ten that got through, got %lld", (long long)gate_inspect(g, M).cap);
  f.t += GATE_WINDOW_MS;
  int admitted = 0;
  for (int i = 0; i < 20; i++) admitted += gate_acquire(g, M) == 0;
  CHECK(admitted == 8, "no ninth request in the same minute: %d", admitted);
  int64_t wait = gate_acquire(g, M);
  CHECK(wait >= GATE_WINDOW_MS && wait < GATE_WINDOW_MS * 1.25, "waits for the oldest to age out: %lld", (long long)wait);
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  gate_record(g, M, 1, 200000);
  CHECK(gate_inspect(g, M).blocked_until == 1000000 + 200000, "retryDelay above the doubling's cap is the floor");
  gate_free(g);
  g = gate_at(&f, 1000000, 1);
  gate_record(g, M, 1, 49000);
  wait = gate_acquire(g, M);
  CHECK(wait >= 49000 && wait <= 49000 * 1.25, "the floor, jittered: %lld", (long long)wait);
  CHECK(gate_inspect(g, M).blocked_until == 1000000 + 49000, "blocked for the retryDelay");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  int64_t want[] = {2000, 4000, 8000, 16000, 32000, 64000, 128000, GATE_MAX_BLOCK_MS, GATE_MAX_BLOCK_MS};
  for (int n = 0; n < 9; n++) {
    f.t = gate_inspect(g, M).blocked_until;
    int64_t at = f.t;
    gate_record(g, M, 1, 0);
    int64_t block = gate_inspect(g, M).blocked_until - at;
    CHECK(block == want[n], "429 number %d blocks %lld, not %lld", n + 1, (long long)block, (long long)want[n]);
  }
  CHECK(GATE_MAX_BLOCK_MS == 180000 && GATE_BASE_BLOCK_MS == 2000, "the block's base and cap");
  gate_record(g, M, 0, -1);
  f.t = gate_inspect(g, M).blocked_until;
  int64_t at = f.t;
  gate_record(g, M, 1, 0);
  CHECK(gate_inspect(g, M).blocked_until - at == GATE_BASE_BLOCK_MS, "a success ends the streak");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  admit(g, &f, 10);
  gate_record(g, M, 1, 1000);
  int64_t learned = gate_inspect(g, M).cap;
  f.t += 2000;
  gate_record(g, M, 0, -1);
  f.t += GATE_WINDOW_MS / 2;
  gate_record(g, M, 0, -1);
  CHECK(gate_inspect(g, M).cap == learned, "half a clean minute is not enough");
  f.t += GATE_WINDOW_MS / 2;
  gate_record(g, M, 0, -1);
  CHECK(gate_inspect(g, M).cap == learned + 1, "one more per clean minute");
  f.t += GATE_WINDOW_MS;
  gate_record(g, M, 0, -1);
  CHECK(gate_inspect(g, M).cap == learned + 2, "and another");
  gate_free(g);

  /* jitter: distinct, in range, replayed by the seed */
  int64_t first[8], again[8], other[8];
  int64_t *runs[] = {first, again, other};
  uint32_t seeds[] = {7, 7, 8};
  for (int r = 0; r < 3; r++) {
    g = gate_at(&f, 1000000, seeds[r]);
    gate_record(g, M, 1, 40000);
    for (int i = 0; i < 8; i++) runs[r][i] = gate_acquire(g, M);
    gate_free(g);
  }
  int distinct = 1, same = 1, differs = 0;
  for (int i = 0; i < 8; i++) {
    CHECK(first[i] >= 40000 && first[i] < 40000 * 1.25, "jittered wait %lld in range", (long long)first[i]);
    for (int j = 0; j < i; j++) distinct &= first[i] != first[j];
    same &= first[i] == again[i];
    differs |= first[i] != other[i];
  }
  CHECK(distinct, "waiters released by one 429 are spread over distinct times");
  CHECK(same, "the same seed replays the same waits");
  CHECK(differs, "another seed, other waits");

  g = gate_at(&f, 0, 1);
  f.fixed = 1;
  gate_acquire(g, M);
  gate_record(g, M, 1, 10000);
  gate_acquire(g, M);
  gate_acquire(g, M);
  CHECK(f.draws == 3, "one draw per acquire, whether or not it waits: %d", f.draws);
  int64_t before = f.draws;
  gate_admission_wait(g);
  CHECK(f.draws == before + 1, "one draw per admission wait");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  admit(g, &f, 10);
  for (int lane = 0; lane < 5; lane++) CHECK(gate_acquire(g, M) == 0, "the five lanes are admitted");
  for (int lane = 0; lane < 5; lane++) gate_record(g, M, 1, 59000);
  CHECK(gate_inspect(g, M).cap == 8, "five refused together still teach the true limit: %lld", (long long)gate_inspect(g, M).cap);
  CHECK(gate_inspect(g, M).in_window == 10, "the refused five left the window: %d", gate_inspect(g, M).in_window);
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  admit(g, &f, 2);
  gate_acquire(g, M);
  gate_record(g, M, 1, 5000);
  CHECK(gate_inspect(g, M).cap == GATE_NO_CAP, "two admitted requests say nothing about a per-minute limit");
  CHECK(gate_acquire(g, M) > 0, "but the block still holds");
  gate_free(g);
  g = gate_at(&f, 1000000, 1);
  admit(g, &f, 3);
  gate_acquire(g, M);
  gate_record(g, M, 1, 5000);
  CHECK(gate_inspect(g, M).cap == 2, "three is enough to learn from");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  CHECK(gate_admission_wait(g) == 0, "nothing known, nothing blocked");
  gate_acquire(g, "gemini-3.8-flash");
  gate_record(g, M, 1, 30000);
  wait = gate_admission_wait(g);
  CHECK(wait >= 30000 && wait < 30000 * 1.25, "new work waits while any model is blocked: %lld", (long long)wait);
  CHECK(gate_inspect(g, "gemini-3.8-flash").in_window == 1, "asking admitted nothing");
  f.t += 30000;
  CHECK(gate_admission_wait(g) == 0, "open again once the block has passed");
  gate_free(g);

  g = gate_at(&f, 1000000, 1);
  gate_record(g, M, 1, 50000);
  CHECK(gate_acquire(g, M) > 0, "the speech model is blocked");
  CHECK(gate_acquire(g, "gemini-3.8-flash") == 0, "models are gated separately");
  gate_free(g);

  CHECK(gate_shared() == gate_shared(), "one gate per process");
}

/* ---- web.c ---- */
static void test_web(void) {
  arena a = {0};
  str out;
  CHECK(amgi_uri_decode(&a, S("%EC%95%88%20x"), &out) && STR_IS(out, "\xec\x95\x88 x"), "decodes UTF-8 escapes");
  CHECK(!amgi_uri_decode(&a, S("%E0%A4%A"), &out), "a cut escape throws");
  CHECK(!amgi_uri_decode(&a, S("%zz"), &out), "a non-hex escape throws");
  CHECK(!amgi_uri_decode(&a, S("%ED%A0%80"), &out), "an encoded surrogate is not UTF-8");
  CHECK(!amgi_uri_decode(&a, S("%C0%AF"), &out), "an overlong form is not UTF-8");
  CHECK(amgi_uri_decode(&a, S("a+b"), &out) && STR_IS(out, "a+b"), "'+' stays '+'");
  CHECK(amgi_query_get(&a, "a=1&offset=2&offset=3", "offset", &out) && STR_IS(out, "2"), "the first value");
  CHECK(amgi_query_get(&a, "x=%zz+y", "x", &out) && STR_IS(out, "%zz y"), "a bad escape kept, '+' a space");
  CHECK(amgi_query_get(&a, "flag", "flag", &out) && out.n == 0, "a key with no '=' is empty");
  CHECK(!amgi_query_get(&a, "", "x", &out), "absent");
  CHECK(amgi_js_number(S("")) == 0 && amgi_js_number(S("  ")) == 0, "Number('') is 0");
  CHECK(amgi_js_number(S(" 1.5 ")) == 1.5 && amgi_js_number(S("0x10")) == 16 && amgi_js_number(S("1e3")) == 1000, "decimal, hex, exponent");
  CHECK(isnan(amgi_js_number(S("abc"))) && isnan(amgi_js_number(S("1x"))) && isnan(amgi_js_number(S("inf"))), "NaN");
  CHECK(isinf(amgi_js_number(S("-Infinity"))) && amgi_js_number(S(".5")) == 0.5 && isnan(amgi_js_number(S("-0x1"))),
        "Infinity, a bare fraction, no signed hex");
  CHECK(amgi_u32(2.5) == 3 && amgi_u32(-1) == 0 && amgi_u32(NAN) == 0 && amgi_u32(1e12) == 0xffffffffu, "the wire's u32");
  str name = amgi_media_name(&a, S("안녕하세요"), S("ko"), "wav");
  CHECK(STR_IS(name, "amgi-dce4d16cea2470806c22.wav"), "audio-store.js's mediaName: %.*s", (int)name.n, name.p);
  ar_free(&a);
}

/* ---- the Gemini pieces ---- */
static void test_gemini(void) {
  arena a = {0};
  str m = gem_daily_quota_message(&a, "gemini-3.8-flash", 1, 0, 0, 1, 20000);
  CHECK(STR_IS(m, "Gemini's free tier allows 10 requests per day per model, and today's are used up for gemini-3.8-flash. "
                  "Enable billing for your Gemini API key's project in Google AI Studio (https://aistudio.google.com/apikey) "
                  "to lift the limit, or try again tomorrow."),
        "the free tier's sentence: %.*s", (int)m.n, m.p);
  m = gem_daily_quota_message(&a, "gemini-3.8-flash-tts", 0, 1, 100, 1, 9000000);
  CHECK(STR_IS(m, "Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up. It resets in about 3 "
                  "hour(s). A higher usage tier raises it (Google AI Studio, https://aistudio.google.com/apikey)."),
        "a billed project's sentence: %.*s", (int)m.n, m.p);
  m = gem_daily_quota_message(&a, "x", 0, 0, 0, 1, 1000);
  CHECK(str_starts(m, S("Your Gemini project's daily limit for x is used up. It resets in about 1 hour(s).")), "at least an hour");

  str pcm = S("\x01\x02\x03\x04"), wav, err;
  wav = gem_pcm_to_wav(&a, pcm, 24000, 1);
  CHECK(wav.n == 48 && !memcmp(wav.p, "RIFF", 4) && !memcmp(wav.p + 8, "WAVEfmt ", 8) && (unsigned char)wav.p[24] == 0xc0 &&
            (unsigned char)wav.p[25] == 0x5d && !memcmp(wav.p + 44, pcm.p, 4),
        "a canonical 44-byte header");
  CHECK(gem_audio_to_wav(&a, S("audio/L16;codec=pcm;rate=16000"), pcm, &wav, &err) == 0 && (unsigned char)wav.p[24] == 0x80 &&
            (unsigned char)wav.p[25] == 0x3e,
        "raw PCM wrapped at its rate");
  CHECK(gem_audio_to_wav(&a, S("audio/wav"), pcm, &wav, &err) < 0 &&
            STR_IS(err, "Gemini said audio/wav but the bytes have no RIFF/WAVE header"),
        "a WAV type with no WAV bytes");
  CHECK(gem_audio_to_wav(&a, S(""), pcm, &wav, &err) < 0 && STR_IS(err, "Gemini returned audio in an unexpected format: no mime type"),
        "no type");
  CHECK(gem_audio_to_wav(&a, S("audio/wavy"), pcm, &wav, &err) < 0, "audio/wavy is not audio/wav");

  /* the 429 log line: the fields, and never the key */
  setenv("GEMINI_API_KEY", "AIza-secret-test-key", 1);
  char line[400];
  gem_quota_line(line, sizeof line, "gemini-3.8-flash-tts", "GenerateRequestsPerMinutePerProjectPerModel", 0, 1, 41000, 8);
  CHECK(!strcmp(line, "429 from gemini-3.8-flash-tts: per-minute quota (GenerateRequestsPerMinutePerProjectPerModel), "
                      "retryDelay 41000 ms, learned cap 8 a minute"),
        "the per-minute line: %s", line);
  CHECK(!strstr(line, "AIza-secret-test-key") && !strstr(line, "x-goog-api-key"), "never the key or a header: %s", line);
  gem_quota_line(line, sizeof line, "gemini-3.8-flash", "GenerateRequestsPerDayPerProjectPerModel-FreeTier", 1, 0, 0,
                 GATE_NO_CAP);
  CHECK(!strcmp(line, "429 from gemini-3.8-flash: daily quota (GenerateRequestsPerDayPerProjectPerModel-FreeTier), "
                      "retryDelay none, learned cap none yet"),
        "the daily line: %s", line);
  CHECK(!strstr(line, "AIza-secret-test-key"), "never the key: %s", line);

  /* the request's bytes for a speech call */
  gem_request q = {0};
  q.parts[0].text = S("hi");
  q.nparts = 1;
  q.voice = "Kore";
  buf b = {0};
  gem_encode(&b, "m", &q);
  /* geminiWire.ts's encode of the same request, byte for byte */
  static const unsigned char WANT[] = {0x0a, 0x08, 0x6d, 0x6f, 0x64, 0x65, 0x6c, 0x73, 0x2f, 0x6d, 0x12, 0x06, 0x0a, 0x04, 0x12,
                                       0x02, 0x68, 0x69, 0x22, 0x11, 0xa2, 0x01, 0x01, 0x03, 0xaa, 0x01, 0x0a, 0x0a, 0x08, 0x0a,
                                       0x06, 0x0a, 0x04, 0x4b, 0x6f, 0x72, 0x65};
  CHECK(b.n == sizeof WANT && !memcmp(b.p, WANT, sizeof WANT), "the speech request's protobuf (%zu bytes)", b.n);
  buf_free(&b);

  gem_part_out parts[3] = {{1, S(" thinking "), 1, 0, 0, {0}, {0}}, {1, S(" yes"), 0, 0, 0, {0}, {0}}, {1, S(" no "), 0, 0, 0, {0}, {0}}};
  gem_response r = {parts, 3, {0}};
  CHECK(STR_IS(gem_response_text(&a, &r), "yes no"), "a response's text, thoughts left out, trimmed");

  /* the voice: never the previous attempt's */
  int ok = 1;
  for (int i = 0; i < 200 && ok; i++) ok = strcmp(gem_pick_voice("Kore"), "Kore") != 0;
  CHECK(ok, "a retry's voice is never the one before it");
  ar_free(&a);
}

static int has(str s, const char *needle) { return memmem(s.p, s.n, needle, strlen(needle)) != NULL; }

/* ---- cards.c: the parts the fake Gemini cannot show (the rest is held by the golden files under
 * tests/server/parity/golden and the fake-Gemini drives) ---- */
static void test_cards(void) {
  arena a = {0};
  card_text t = {S("안녕"), S("hello"), S("r")};
  card_text s = card_correct_swapped_sides(&a, t, S("ko"));
  CHECK(STR_IS(s.front_text, "hello") && STR_IS(s.back_text, "안녕") && s.spoken_reading.n == 0, "swapped, the reading dropped");
  s = card_correct_swapped_sides(&a, t, S("es"));
  CHECK(STR_IS(s.front_text, "안녕"), "nothing to tell apart for a Latin-script language");
  const char *in_ko = card_detect_input_language(&a, S("그대 still with you"), S("ko"));
  CHECK(in_ko && !strcmp(in_ko, "learning"), "any Hangul is the learning side");
  CHECK(!card_detect_input_language(&a, S("hello"), S("ko")), "Latin letters are never declared to be the known language");
  CHECK(!card_detect_input_language(&a, S("123"), S("ko")), "no letters at all says nothing");
  CHECK(!card_detect_input_language(&a, S("고양이"), S("es")), "a Latin-script learning language has no script to tell it by");
  /* Spanish pasted into an English -> Chinese deck is only the meaning to translate: the prompt's both-ways rule reads it. */
  str hola = card_generation_prompt(&a, S("hola amigo"), S("en"), S("zh_cn"), card_detect_input_language(&a, S("hola amigo"), S("zh_cn")));
  CHECK(has(hola, "If the input is in any other language, translate it into both.") && !has(hola, "The input is written in English"),
        "hola amigo, English -> Chinese: both ways");
  const char *zh = card_detect_input_language(&a, S("车站在哪里"), S("zh_cn"));
  str station = card_generation_prompt(&a, S("车站在哪里"), S("en"), S("zh_cn"), zh);
  CHECK(has(station, "The input is written in Mandarin Chinese.") && !has(station, "If the input is in any other language"),
        "a Chinese input in an English -> Chinese deck is the learning side");
  ar_free(&a);
}

/* ---- the deck-languages request (cards.c): its text, its schema, its system prompt ---- */
static void test_deck_languages_request(void) {
  arena a = {0};
  str names[] = {S("Front"), S("Back"), S("Audio")};
  str fields[] = {S("<div>hello&nbsp;<b>world</b></div>"), S("你好[sound:a.mp3]"), S("[sound:b.mp3]")};
  card_sample one = {S("Basic"), names, fields, 3};
  str p = card_deck_languages_prompt(&a, S("Mandarin::Phrases"), &one, 1, S(""));
  CHECK(has(p, "Deck name: Mandarin::Phrases") && has(p, "Note 1, note type \"Basic\"") && has(p, "Front: hello world\n") &&
        has(p, "Back: 你好\n"), "the deck's name, the note type, the fields with tags, entities and [sound:] gone: %.*s", (int)p.n, p.p);
  CHECK(!has(p, "<") && !has(p, "sound") && !has(p, "Audio"), "no tag, no sound reference, and an emptied field is not listed");
  CHECK(!has(p, "Fact"), "no fact when the notes say none");
  CHECK(has(card_deck_languages_prompt(&a, S("D"), &one, 1, S("ko")), "Fact, read from the deck's own cards: the language this deck teaches is Korean (ko)"),
        "the learning language the notes agree on is stated as fact");
  /* a field is cut to 80 characters, never inside one */
  char longa[400] = {0};
  memset(longa, 'a', 200);
  str lf[] = {str_c(longa)};
  str ln[] = {S("Front")};
  card_sample ls = {S("Basic"), ln, lf, 1};
  str cut = card_deck_languages_prompt(&a, S("D"), &ls, 1, S(""));
  CHECK(has(cut, "aaa...\n"), "cut with an ellipsis");
  size_t run = 0, best = 0;
  for (size_t i = 0; i < cut.n; i++) {
    run = cut.p[i] == 'a' ? run + 1 : 0;
    if (run > best) best = run;
  }
  CHECK(best == 80, "exactly 80 characters kept, not %zu", best);
  char korean[800] = {0};
  for (int i = 0; i < 100; i++) memcpy(korean + i * 3, "일", 3);
  lf[0] = str_c(korean);
  str kcut = card_deck_languages_prompt(&a, S("D"), &ls, 1, S(""));
  size_t chars = 0, bad = 0, from = 0;
  for (size_t i = 0; i < kcut.n; i++)
    if (!memcmp(kcut.p + i, "Front: ", 7)) from = i + 7;
  for (size_t i = from; i < kcut.n && kcut.p[i] != '.' && kcut.p[i] != '\n'; i++) {
    unsigned char c = (unsigned char)kcut.p[i];
    if ((c & 0xC0) != 0x80) chars++;
    if (c >= 0x80 && (c & 0xC0) != 0x80 && (c & 0xF0) != 0xE0) bad++;
  }
  CHECK(chars == 80 && bad == 0, "80 Korean characters, each whole: %zu chars, %zu odd", chars, bad);
  /* at most ten notes */
  card_sample many[14];
  for (int i = 0; i < 14; i++) many[i] = ls;
  lf[0] = S("x");
  str ten = card_deck_languages_prompt(&a, S("D"), many, 14, S(""));
  CHECK(has(ten, "Note 10,") && !has(ten, "Note 11,"), "ten notes at most");
  CHECK(has(card_deck_languages_prompt(&a, S("D"), NULL, 0, S("")), "The deck has no notes."), "an empty deck says so");
  /* the schema: learning and known are each the table's codes, in its order, then none; confidence is high or low */
  buf expect = {0}, item = {0}, items = {0}, list = {0};
  for (uint32_t i = 0; i <= NLANGUAGES; i++) {
    item.n = 0;
    gv_string(&item, i < NLANGUAGES ? LANGUAGES[i].code : "none");
    gv_list_item(&items, &item);
  }
  gv_list_of(&list, &items);
  gv_field(&expect, "enum", &list);
  buf schema = {0};
  card_schema_deck_languages(&a, &schema);
  size_t found = 0;
  for (size_t i = 0; i + expect.n <= schema.n; i++)
    if (!memcmp(schema.p + i, expect.p, expect.n)) found++;
  CHECK(found == 2, "learning and known each take the 18 codes and none, in the table's order (%zu)", found);
  CHECK(memmem(schema.p, schema.n, "confidence", 10) && memmem(schema.p, schema.n, "high", 4) && memmem(schema.p, schema.n, "low", 3),
        "confidence is high or low");
  buf_free(&expect), buf_free(&item), buf_free(&items), buf_free(&list), buf_free(&schema);
  const char *sys = card_deck_languages_system(&a);
  int all = 1;
  for (uint32_t i = 0; i < NLANGUAGES; i++) {
    char one_code[96];
    snprintf(one_code, sizeof one_code, "%s (%s)", LANGUAGES[i].code, LANGUAGES[i].english);
    all = all && strstr(sys, one_code);
  }
  CHECK(all && strstr(sys, "zh_cn is Mandarin Chinese in simplified characters") && strstr(sys, "zh_hk is Cantonese") && strstr(sys, "\"none\""),
        "the system prompt names every code with its English name");
  ar_free(&a);
}

/* ---- the one language table (ui/wire/lang.c): the page and the server read the same one ---- */
static void test_languages(void) {
  /* The 18 codes the page offered before the table moved, in its order. */
  static const char *const CODES[] = {"en", "zh_cn", "es", "fr", "pt", "ru", "id", "de", "ja",
                                      "tr", "zh_hk", "vi", "ko", "it", "th", "hi", "ur", "ar"};
  CHECK(NLANGUAGES == sizeof CODES / sizeof *CODES, "%u languages", NLANGUAGES);
  for (uint32_t i = 0; i < NLANGUAGES && i < sizeof CODES / sizeof *CODES; i++)
    CHECK(!strcmp(LANGUAGES[i].code, CODES[i]), "language %u is %s, not %s", i, LANGUAGES[i].code, CODES[i]);
  CHECK(!strcmp(LANGUAGES[1].name, "中文") && !strcmp(LANGUAGES[12].name, "한국어"), "the native names are the page's");
  CHECK(!strcmp(LANGUAGES[1].english, "Mandarin Chinese") && !strcmp(LANGUAGES[10].english, "Cantonese"), "the English names are the prompts'");
  for (uint32_t i = 0; i < NLANGUAGES; i++)
    CHECK(LANGUAGES[i].flag[0] && LANGUAGES[i].name[0] && LANGUAGES[i].english[0], "language %u is whole", i);
  arena a = {0};
  CHECK(STR_IS(card_language_name(&a, S("zh-CN")), "Mandarin Chinese"), "card_language_name takes its names from the table");
  CHECK(STR_IS(card_language_name(&a, S("xx")), "xx") && STR_IS(card_language_name(&a, S("")), "the target language"), "and keeps its fallbacks");
  ar_free(&a);
  CHECK(lang_known("ko", 2) && lang_known("zh_cn", 5) && !lang_known("zh", 2) && !lang_known("KO", 2) && !lang_known("", 0) &&
          !lang_known("ko ", 3) && !lang_known("kox", 3) && !lang_known("xx", 2),
        "lang_known is the exact code");
  CHECK(lang_pair_ok("en", 2, "ko", 2) && !lang_pair_ok("en", 2, "en", 2) && !lang_pair_ok("en", 2, "xx", 2) &&
          !lang_pair_ok("", 0, "ko", 2),
        "a pair is two different known codes");
}

int main(void) {
  test_gate();
  test_web();
  test_gemini();
  test_cards();
  test_deck_languages_request();
  test_languages();
  printf("app unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
