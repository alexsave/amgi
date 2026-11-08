/* POST /card-text and POST /audio: the port of what were the card-text and audio routes (src/server/api/anki/card-text and
 * audio), src/server/anki/cardText.js (the one-pass rule: the reading the text call gives steers the
 * clip made in the same request, and is then dropped), audio.js (a clip named by its content,
 * reused unless a fresh take is asked for, added as media) and rateLimit.js (the gate's 429s), all
 * in process: the generation runs on the request's own thread, and the rate gate is a function call
 * (gate.h), where Node forked two scripts and answered their gate over IPC.
 *
 * What a person reads when a script failed is kept: Node showed the last line of the script's
 * stderr, which was the error's own message, so a message is cut to its last non-empty line here. */
#include <stdlib.h>
#include <string.h>

#include "amgi.h"
#include "cards.h"
#include "gate.h"
#include "gemini.h"
#include "messages.h"

int amgi_generation_available(void) {
  const char *k = getenv("GEMINI_API_KEY");
  return k && *k;
}

int amgi_gen_open(char *err, size_t cap) { return gem_open(err, cap); }
void amgi_gen_close(void) { gem_close(); }

/* plusaudioCli.js failureMessage: the last non-empty trimmed line, or the fallback. */
static str last_line(str m, const char *fallback) {
  str best = {0};
  size_t at = 0;
  while (at <= m.n) {
    size_t e = at;
    while (e < m.n && m.p[e] != '\n') e++;
    str line = js_trim(str_sub(m, at, e));
    if (line.n) best = line;
    at = e + 1;
  }
  return best.n ? best : str_c(fallback);
}

/* limitResponse, or a 500 with the message. */
static void fail(arena *a, cb_http_res *res, const gem_err *e, const char *fallback) {
  amgi_error out = {0};
  out.error = last_line(e->message, fallback);
  if (e->kind == GE_RATE) {
    out.has_retry = 1;
    out.retry_after_ms = e->retry_after_ms < 0 ? 0 : (uint32_t)e->retry_after_ms;
    amgi_send_error(a, res, 429, &out);
    return;
  }
  if (e->kind == GE_DAILY) {
    out.daily_cap = 1;
    amgi_send_error(a, res, 429, &out);
    return;
  }
  amgi_send_error(a, res, 500, &out);
}
static void fail_plain(arena *a, cb_http_res *res, str message) { amgi_send_message(a, res, 500, message); }

/* rateLimit.js admissionRefusal: 1 when it answered (a 429 before anything starts). */
static int admission_refused(arena *a, cb_http_res *res) {
  int64_t wait = gate_admission_wait(gate_shared());
  if (wait <= 0) return 0;
  amgi_error e = {0};
  e.error = str_c(ar_fmt(a, "Gemini's per-minute limit is reached; this card waits %llds before starting.",
                         (long long)((wait + 999) / 1000)));
  e.has_retry = 1;
  e.retry_after_ms = (uint32_t)wait;
  e.not_started = 1;
  amgi_send_error(a, res, 429, &e);
  return 1;
}

typedef struct { str filename, reference; int reused; } clip;

/* generateAndStoreClip: 0, or -1 having answered. */
static int store_clip(arena *a, const amgi_ops *o, str text, str language, str reading, int fresh, clip *out,
                      cb_http_res *res) {
  str name = amgi_media_name(a, text, language, "wav");
  col_err ce = {0};
  if (!fresh) {
    int has;
    if (ops_has_media(a, o, name, &has, &ce)) return fail_plain(a, res, ce.message), -1;
    if (has) {
      *out = (clip){name, amgi_audio_reference(a, name), 1};
      return 0;
    }
  }
  if (!amgi_generation_available()) return fail_plain(a, res, S(MISSING_KEY_MESSAGE)), -1;
  str wav;
  gem_err e = {0};
  if (card_generate_audio(a, text, language, reading, &wav, &e)) return fail(a, res, &e, "audio generation failed"), -1;
  str stored;
  if (ops_add_media(a, o, name, wav.p, wav.n, &stored, &ce)) return fail_plain(a, res, ce.message), -1;
  *out = (clip){stored, amgi_audio_reference(a, stored), 0};
  return 0;
}

void amgi_card_text(arena *a, const amgi_ops *o, const char *mode, const wire_q_card_text *q, cb_http_res *res) {
  str input = js_trim(amgi_str(q->user_input)), known = amgi_str(q->known_language), learning = amgi_str(q->learning_language);
  if (!input.n || !known.n || !learning.n) {
    amgi_send_message(a, res, 400, S("userInput, knownLanguage and learningLanguage are required"));
    return;
  }
  if (admission_refused(a, res)) return;
  if (!amgi_generation_available()) {
    fail_plain(a, res, S(MISSING_KEY_MESSAGE));
    return;
  }
  card_text t;
  gem_err e = {0};
  if (card_generate_text(a, input, known, learning, card_detect_input_language(a, input, known, learning), &t, &e)) {
    fail(a, res, &e, "card text generation failed");
    return;
  }
  /* Before any audio: the clips are recorded from these two strings. */
  t = card_correct_swapped_sides(a, t, learning);
  clip audio, cue = {{"", 0}, {"", 0}, 0};
  if (store_clip(a, o, t.back_text, learning, t.spoken_reading, 0, &audio, res)) return;
  if (q->include_cue_audio == 1 && store_clip(a, o, t.front_text, known, S(""), 0, &cue, res)) return;
  wire_card_text w = {wire_mode_of(mode, (uint32_t)strlen(mode)), amgi_ws(t.front_text), amgi_ws(t.back_text),
                      {amgi_ws(audio.filename), amgi_ws(audio.reference)}, {amgi_ws(cue.filename), amgi_ws(cue.reference)}};
  amgi_send_wire(a, res, 200, WK_CARD_TEXT, &w);
}

void amgi_audio(arena *a, const amgi_ops *o, const char *mode, const wire_q_audio *q, cb_http_res *res) {
  str text = js_trim(amgi_str(q->text)), language = amgi_str(q->language);
  if (!text.n || !language.n) {
    amgi_send_message(a, res, 400, S("text and language are required"));
    return;
  }
  if (admission_refused(a, res)) return;
  clip c;
  if (store_clip(a, o, text, language, S(""), q->fresh == 1, &c, res)) return;
  wire_clip w = {wire_mode_of(mode, (uint32_t)strlen(mode)), amgi_ws(c.filename), amgi_ws(c.reference), (uint8_t)c.reused};
  amgi_send_wire(a, res, 200, WK_CLIP, &w);
}
