/* model_answer.h: the model's answer through the quarantine's JSON.parse. */
#include "model_answer.h"

#include <string.h>

/* text.slice(0, 80): the first 80 UTF-16 code units, without cutting a character in two (a pair cut
 * after its first half would read back as U+FFFD; the whole character is dropped instead). */
static str slice80(str text) {
  size_t at = 0, units = 0;
  while (at < text.n) {
    size_t from = at;
    uint32_t cp = utf8_next(text, &at);
    size_t u = cp >= 0x10000 ? 2 : 1;
    if (units + u > 80) return str_sub(text, 0, from);
    units += u;
  }
  return text;
}

aj *model_answer_parse(arena *a, str text, str *detail) {
  const char *why = NULL;
  aj *v = anki_json_parse(a, text, &why);
  if (!v) *detail = str_c(ar_fmt(a, "not JSON: \"%.*s\"", (int)slice80(text).n, text.p));
  return v;
}
