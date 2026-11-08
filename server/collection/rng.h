/* The one random source in amgi's C, as plusaudio/lib/random.js is the one in its JavaScript: the
 * same generator (sfc32, its 128-bit state spread from one 32-bit seed by splitmix32, twelve
 * warm-up draws), so a seed gives the same draws in both.
 *
 * To make every run reproducible, change AMGI_SEED in rng.c to a constant (any 32-bit integer).
 * That one line is the whole switch. Left as -1, the process draws one seed from the OS the first
 * time a draw is made, which is the only non-deterministic step there is. A fixed seed is for
 * debugging only: two runs with the same seed make the same note guids, and Anki treats a matching
 * guid as the same note.
 *
 * Every draw goes through rng_uint32, under one lock (the collection core runs on several threads
 * in the server). test/no-random.test.mjs fails on any other random or clock-seeded source in
 * the native code. */
#ifndef AMGI_COL_RNG_H
#define AMGI_COL_RNG_H
#include <stddef.h>
#include <stdint.h>

typedef struct { uint32_t a, b, c, d; } rng;
void rng_seed(rng *r, uint32_t seed); /* a generator of its own, for a test that needs a known sequence */
uint32_t rng_next(rng *r);

uint32_t rng_uint32(void);              /* one draw from the process-wide generator */
void rng_bytes(uint8_t *out, size_t n); /* random.js bytes(): one draw per 4 bytes, little-endian within each */
#endif
