/* The card policy's pure functions (server/amgi/cards.c), for the golden-file tests in
 * tests/server/parity/golden_korean.test.mjs and golden_judge.test.mjs. It reads records on stdin, each
 * (u8 op, u32 length, the language's bytes, u32 length, the text's bytes), and answers each with
 * (u32 length, bytes):
 *   k  koreanPronunciation(text)
 *   n  normalizeForComparison(text, language)
 *   s  spokenForm(text)
 *   a  readingIsAmbiguous(language): "1" or "0"
 * Built by those tests themselves (make -C server build/golden_cards with APP_PROGS extended on the
 * command line), so no shared build file changes. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../amgi/cards.h"

static int read_exact(void *p, size_t n) { return fread(p, 1, n, stdin) == n; }
static int read_str(arena *a, str *out) {
  uint32_t n;
  if (!read_exact(&n, 4)) return 0;
  char *p = ar_alloc(a, (size_t)n + 1);
  if (n && !read_exact(p, n)) return 0;
  *out = (str){p, n};
  return 1;
}
static void put(str s) {
  uint32_t n = (uint32_t)s.n;
  fwrite(&n, 4, 1, stdout);
  if (n) fwrite(s.p, 1, n, stdout);
}

int main(void) {
  int op;
  while ((op = getchar()) != EOF) {
    arena a = {0};
    str language, text;
    if (!read_str(&a, &language) || !read_str(&a, &text)) return 2;
    switch (op) {
    case 'k': put(card_korean_pronunciation(&a, text)); break;
    case 'n': put(card_normalize_for_comparison(&a, text, language)); break;
    case 's': put(card_spoken_form(&a, text)); break;
    case 'a': put(card_reading_is_ambiguous(&a, language) ? str_c("1") : str_c("0")); break;
    default: return 3;
    }
    ar_free(&a);
  }
  fflush(stdout);
  return 0;
}
