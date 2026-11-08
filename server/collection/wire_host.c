/* wire.h's wire_grow, which "the build supplies": the native side's, on realloc. One owner for
 * every native program that writes the wire (the bridge client today, the amgi app at L2). */
#include <stdio.h>
#include <stdlib.h>

#include "wire.h"

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) {
  (void)len;
  uint8_t *q = realloc(p, cap ? cap : 1);
  if (!q) {
    fputs("amgi: out of memory writing a wire message\n", stderr);
    abort();
  }
  return q;
}

/* A body's length as a wire message's u32 count can hold it, or 0. cbase bounds a response at
 * CB_HTTPS_MAX_BODY (32 MiB), so this never fails today; it is the one place the cast is checked. */
int wire_length_fits(size_t n) { return n <= 0xffffffffu; }
