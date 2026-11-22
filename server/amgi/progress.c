/* The cards being made now (progress.h). */
#include "progress.h"

#include <pthread.h>
#include <string.h>
#include <time.h>

_Static_assert(WP_CUE_REUSE - WP_TARGET_REUSE == AUDIO_STEPS && WP_STEPS - WP_CUE_REUSE == AUDIO_STEPS,
               "wire.h lists the audio steps once for each side, in progress.h's order");

struct progress {
  uint32_t id; /* 0: the entry is free */
  uint32_t step, take, takes, side;
  int64_t wait_until; /* monotonic ms, or 0: not waiting */
  str front, back;
};

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static progress table[PROGRESS_MAX];

static int64_t monotonic(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

progress *progress_begin(uint32_t id) {
  if (!id) return NULL;
  progress *p = NULL;
  pthread_mutex_lock(&lock);
  for (size_t i = 0; i < PROGRESS_MAX && !p; i++)
    if (!table[i].id) p = &table[i];
  if (p) *p = (progress){.id = id, .side = WP_TARGET_REUSE};
  pthread_mutex_unlock(&lock);
  return p;
}

void progress_end(progress *p) {
  if (!p) return;
  pthread_mutex_lock(&lock);
  memset(p, 0, sizeof *p);
  pthread_mutex_unlock(&lock);
}

static void set_step(progress *p, uint32_t step, uint32_t take, uint32_t takes) {
  pthread_mutex_lock(&lock);
  p->step = step;
  p->take = take;
  p->takes = takes;
  pthread_mutex_unlock(&lock);
}

void progress_writing(progress *p, uint32_t take, uint32_t takes) {
  if (p) set_step(p, WP_WRITING, take, takes);
}

void progress_texts(progress *p, str front, str back) {
  if (!p) return;
  pthread_mutex_lock(&lock);
  p->front = front;
  p->back = back;
  pthread_mutex_unlock(&lock);
}

void progress_side(progress *p, int cue) {
  if (!p) return;
  pthread_mutex_lock(&lock);
  p->side = cue ? WP_CUE_REUSE : WP_TARGET_REUSE;
  pthread_mutex_unlock(&lock);
}

void progress_audio(progress *p, int audio_step, uint32_t take, uint32_t takes) {
  if (p) set_step(p, p->side + (uint32_t)audio_step, take, takes); /* side is this thread's own to write */
}

void progress_wait(progress *p, int64_t ms) {
  if (!p) return;
  int64_t until = ms > 0 ? monotonic() + ms : 0;
  pthread_mutex_lock(&lock);
  p->wait_until = until;
  pthread_mutex_unlock(&lock);
}

static wire_str copy(arena *a, str s) {
  if (!s.n) return (wire_str){"", 0};
  return (wire_str){ar_dup(a, s.p, s.n), (uint32_t)s.n};
}

wire_progress progress_list(arena *a) {
  wire_progress out = {ar_alloc(a, PROGRESS_MAX * sizeof(wire_card_progress)), 0};
  int64_t now = monotonic();
  pthread_mutex_lock(&lock);
  for (size_t i = 0; i < PROGRESS_MAX; i++) {
    const progress *p = &table[i];
    if (!p->id || !p->step) continue; /* free, or admitted and not at a step yet */
    /* a wait that is all but over is still a wait, until progress_wait(p, 0) says it is not */
    uint32_t wait = !p->wait_until ? 0 : p->wait_until > now ? (uint32_t)(p->wait_until - now) : 1;
    out.cards[out.ncards++] = (wire_card_progress){p->id, p->step, p->take, p->takes, wait, copy(a, p->front), copy(a, p->back)};
  }
  pthread_mutex_unlock(&lock);
  return out;
}
