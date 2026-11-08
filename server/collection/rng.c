#include "rng.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/random.h>
#include <unistd.h>

/* -1: seed from the OS once per process. A number (0..4294967295): deterministic. */
#define AMGI_SEED (-1)

static uint32_t splitmix32(uint32_t *state) {
  *state += 0x9e3779b9u;
  uint32_t z = *state;
  z = (z ^ (z >> 16)) * 0x85ebca6bu;
  z = (z ^ (z >> 13)) * 0xc2b2ae35u;
  return z ^ (z >> 16);
}

void rng_seed(rng *r, uint32_t seed) {
  uint32_t s = seed;
  r->a = splitmix32(&s);
  r->b = splitmix32(&s);
  r->c = splitmix32(&s);
  r->d = splitmix32(&s);
  for (int i = 0; i < 12; i++) rng_next(r);
}

uint32_t rng_next(rng *r) {
  uint32_t t = r->a + r->b + r->d;
  r->d += 1;
  r->a = r->b ^ (r->b >> 9);
  r->b = r->c + (r->c << 3);
  r->c = (r->c << 21) | (r->c >> 11);
  r->c += t;
  return t;
}

static rng process_rng;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void seed_once(void) {
  uint32_t seed = (uint32_t)AMGI_SEED;
  if (AMGI_SEED < 0 && getentropy(&seed, sizeof seed) != 0) {
    perror("amgi: getentropy");
    abort();
  }
  rng_seed(&process_rng, seed);
}

uint32_t rng_uint32(void) {
  pthread_once(&once, seed_once);
  pthread_mutex_lock(&lock);
  uint32_t v = rng_next(&process_rng);
  pthread_mutex_unlock(&lock);
  return v;
}

void rng_bytes(uint8_t *out, size_t n) {
  for (size_t i = 0; i < n; i += 4) {
    uint32_t w = rng_uint32();
    for (size_t j = 0; j < 4 && i + j < n; j++) out[i + j] = (uint8_t)(w >> (8 * j));
  }
}
