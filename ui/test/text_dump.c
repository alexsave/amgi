/* ui/src/text.c and fields.c natively, for ui/test/text.test.mjs: it reads records of (u32 function,
 * u32 length, bytes) on stdin and writes each answer as (u32 length, bytes). Functions:
 * 0 trim, 1 strip_html, 2 strip_tags, 3 audio_src, 4 has_audio_ref ("1"/"0"), 5 dedupe_key,
 * 6 guess_fields: names split by 0x1f, then 0x1e and the sort field's index (or nothing), answered
 * "text,audio,cue". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/app.h"

void *cd_alloc(uint32_t n) { return malloc(n ? n : 1); }
void cd_free(void *p) { free(p); }

static void put(const char *p, uint32_t n) {
  fwrite(&n, 4, 1, stdout);
  fwrite(p, 1, n, stdout);
}

int main(void) {
  uint32_t fn, len;
  while (fread(&fn, 4, 1, stdin) == 1 && fread(&len, 4, 1, stdin) == 1) {
    char *in = malloc(len + 1), *out = malloc(len + 64);
    if (fread(in, 1, len, stdin) != len) return 1;
    wire_str s = {in, len};
    switch (fn) {
    case 0: { wire_str t = trim(s); put(t.p, t.len); break; }
    case 1: put(out, strip_html(out, s)); break;
    case 2: put(out, strip_tags(out, s)); break;
    case 3: { wire_str t = audio_src(s); put(t.p, t.len); break; }
    case 4: put(has_audio_ref(s) ? "1" : "0", 1); break;
    case 5: put(out, dedupe_key(out, s)); break;
    case 6: {
      text names[32];
      uint32_t n = 0, sort = WIRE_NONE, start = 0, end = len;
      char *rs = memchr(in, 0x1e, len);
      if (rs) {
        end = (uint32_t)(rs - in);
        if (end + 1 < len) sort = (uint32_t)atoi(rs + 1);
      }
      for (uint32_t i = 0; i <= end && n < 32; i++) {
        if (i == end || in[i] == 0x1f) {
          if (i > start || i < end || end) names[n++] = (text){in + start, i - start};
          start = i + 1;
        }
      }
      if (!end) n = 0;
      field_guess g = guess_fields(names, n, sort);
      put(out, (uint32_t)snprintf(out, 64, "%d,%d,%d", g.text, g.audio, g.cue_audio));
      break;
    }
    }
    free(in);
    free(out);
  }
  return 0;
}
