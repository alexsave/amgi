/* Tests of the amgi app's own C (server/amgi), built under ASan and UBSan (make -C server check-app,
 * run by npm test). The routes themselves are proven over HTTP by test/parity/http.test.mjs; this
 * holds what HTTP cannot reach, or cannot reach exactly:
 *   - the rate gate (gate.c), plusaudio/test/rateGate.test.js case for case, on a fake clock and a
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

#include "../amgi/amgi.h"
#include "../amgi/cards.h"
#include "../amgi/gate.h"
#include "../amgi/gemini.h"
#include "../collection/rng.h"

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
  CHECK(STR_IS(name, "plusaudio-dce4d16cea2470806c22.wav"), "audio-store.js's mediaName: %.*s", (int)name.n, name.p);
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

/* ---- cards.c: the parts the fake Gemini cannot show (the rest is compared with cardText.ts by
 * test/parity/prompts.test.mjs) ---- */
static void test_cards(void) {
  arena a = {0};
  card_text t = {S("안녕"), S("hello"), S("r")};
  card_text s = card_correct_swapped_sides(&a, t, S("ko"));
  CHECK(STR_IS(s.front_text, "hello") && STR_IS(s.back_text, "안녕") && s.spoken_reading.n == 0, "swapped, the reading dropped");
  s = card_correct_swapped_sides(&a, t, S("es"));
  CHECK(STR_IS(s.front_text, "안녕"), "nothing to tell apart for a Latin-script language");
  CHECK(card_detect_input_language(&a, S("그대 still with you"), S("en"), S("ko")) && !strcmp(card_detect_input_language(&a, S("그대 still"), S("en"), S("ko")), "learning"),
        "any Hangul is the learning side");
  CHECK(!strcmp(card_detect_input_language(&a, S("hello"), S("en"), S("ko")), "known"), "Latin and no Hangul is the known side");
  CHECK(!card_detect_input_language(&a, S("123"), S("en"), S("ko")), "no letters at all says nothing");
  CHECK(!card_detect_input_language(&a, S("hello"), S("ja"), S("ko")), "a non-Latin known language says nothing");
  ar_free(&a);
}

int main(void) {
  test_gate();
  test_web();
  test_gemini();
  test_cards();
  printf("app unit: %d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
