/* The C side of test/parity/prompts.test.mjs (removed at L4, with the TypeScript it compares
 * against): server/amgi/cards.c's text policy and prompts, one call per line.
 *
 * In: lines of fields separated by 0x1f, the first the function's name; a field's line breaks are
 * sent as 0x1e. Out: one line per call, its answer with line breaks as 0x1e (none: an empty line
 * stands for JavaScript's null). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../amgi/cards.h"

static str unesc(arena *a, str s) {
  char *p = ar_dup(a, s.p, s.n);
  for (size_t i = 0; i < s.n; i++)
    if (p[i] == 0x1e) p[i] = '\n';
  return (str){p, s.n};
}
static void out(str s) {
  for (size_t i = 0; i < s.n; i++) putchar(s.p[i] == '\n' ? 0x1e : s.p[i]);
  putchar('\n');
}
static void hexout(const buf *b) {
  for (size_t i = 0; i < b->n; i++) printf("%02x", (unsigned char)b->p[i]);
  putchar('\n');
}

int main(void) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, stdin)) > 0) {
    if (line[len - 1] == '\n') line[--len] = 0;
    arena a = {0};
    str f[8];
    size_t n = 0, at = 0;
    for (ssize_t i = 0; i <= len && n < 8; i++)
      if (i == len || line[i] == 0x1f) f[n++] = unesc(&a, (str){line + at, (size_t)i - at}), at = (size_t)i + 1;
    for (size_t i = n; i < 8; i++) f[i] = S("");
#define IS(name) str_eq_c(f[0], name)
    if (IS("spokenForm")) out(card_spoken_form(&a, f[1]));
    else if (IS("speakableUtterance")) out(card_speakable_utterance(&a, f[1]));
    else if (IS("unspeakableReason")) {
      const char *r = card_unspeakable_reason(&a, f[1]);
      out(r ? str_c(r) : S(""));
    } else if (IS("composeKnownSide")) out(card_compose_known_side(&a, f[1], f[2], f[3].n ? str_z(&a, f[3]) : NULL));
    else if (IS("registerTag")) {
      const char *r = card_register_tag(&a, f[1], f[2]);
      out(r ? str_c(r) : S(""));
    } else if (IS("normalizeForComparison")) out(card_normalize_for_comparison(&a, f[1], f[2]));
    else if (IS("koreanPronunciation")) out(card_korean_pronunciation(&a, f[1]));
    else if (IS("languageName")) out(card_language_name(&a, f[1]));
    else if (IS("hasNativeScript")) out(card_has_native_script(&a, f[1], f[2]) ? S("1") : S("0"));
    else if (IS("detectInputLanguage")) {
      const char *r = card_detect_input_language(&a, f[1], f[2], f[3]);
      out(r ? str_c(r) : S(""));
    } else if (IS("correctSwappedSides")) {
      card_text t = card_correct_swapped_sides(&a, (card_text){f[1], f[2], f[3]}, f[4]);
      out(str_cat3(&a, t.front_text, S("\x1d"), str_cat3(&a, t.back_text, S("\x1d"), t.spoken_reading)));
    } else if (IS("prompt")) {
      out(card_generation_prompt(&a, f[1], f[2], f[3], f[4].n ? str_z(&a, f[4]) : NULL));
    } else if (IS("retryPrompt")) {
      out(card_unspeakable_retry_prompt(&a, f[1], f[2], str_z(&a, f[3])));
    } else if (IS("schema")) {
      buf b = {0};
      if (str_eq_c(f[1], "generated")) card_schema_generated(&b);
      else if (str_eq_c(f[1], "verdict")) card_schema_audio_verdict(&b);
      else card_schema_transcription_match(&b);
      hexout(&b);
      buf_free(&b);
    } else {
      out(S("?"));
    }
    fflush(stdout);
    ar_free(&a);
  }
  free(line);
  return 0;
}
