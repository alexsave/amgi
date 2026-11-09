/* Every obfuscated UI string decodes back to its exact original. The blob and the decode come from
 * out/gen/am_blob_data.h (what the module ships); the plaintext comes from out/gen/am_check.h (the
 * roundtrip reference, never compiled into the module). Both are written by ui/tools/textgen.c.
 *
 * Mutation check: corrupt one byte of AM_B, or one term of am_key, in out/gen/am_blob_data.h and run
 * this binary again - it must report a mismatch - then regenerate to restore. */
#include <stdio.h>
#include <string.h>
#include "am_blob_data.h"
#include "am_check.h"

int main(void) {
  unsigned char buf[AM_MAXLEN];
  unsigned fails = 0, off = 0;
  for (unsigned id = 0; id < AM_N; id++) {
    unsigned n = am_decode(id, buf);
    unsigned want = AM_PLAIN_LEN[id];
    if (n != want || memcmp(buf, AM_PLAIN + off, want) != 0) {
      fprintf(stderr, "id %u: decode mismatch (got len %u, want %u)\n", id, n, want);
      fails++;
    }
    off += want;
  }
  if (fails) { fprintf(stderr, "am_decode_test: %u of %u strings FAILED\n", fails, AM_N); return 1; }
  printf("am_decode_test: %u strings decode losslessly\n", AM_N);
  return 0;
}
