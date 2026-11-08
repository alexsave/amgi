/* plusaudio/lib/rateGate.js in C (gate.h). */
#include "gate.h"

#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../collection/rng.h"

#define JITTER 0.25
#define DECREASE 0.8
#define MIN_EVIDENCE 3

typedef struct model_state {
  struct model_state *next;
  char *model;
  int64_t blocked_until;
  int64_t *starts;
  size_t nstarts, cap_starts;
  int64_t cap;
  int consecutive429;
  int has_clean;
  int64_t clean_since;
} model_state;

struct gate {
  pthread_mutex_t lock;
  gate_clock now;
  gate_draw draw;
  void *ud;
  model_state *models, *last; /* in the order they were first seen, as a Map keeps them */
};

gate *gate_new(gate_clock now, gate_draw draw, void *ud) {
  gate *g = calloc(1, sizeof *g);
  if (!g) abort();
  pthread_mutex_init(&g->lock, NULL);
  g->now = now, g->draw = draw, g->ud = ud;
  return g;
}

void gate_free(gate *g) {
  if (!g) return;
  for (model_state *m = g->models, *n; m; m = n) {
    n = m->next;
    free(m->model);
    free(m->starts);
    free(m);
  }
  pthread_mutex_destroy(&g->lock);
  free(g);
}

static model_state *state_of(gate *g, const char *model) {
  for (model_state *m = g->models; m; m = m->next)
    if (!strcmp(m->model, model)) return m;
  model_state *m = calloc(1, sizeof *m);
  if (!m || !(m->model = strdup(model))) abort();
  m->cap = GATE_NO_CAP;
  if (g->last) g->last->next = m;
  else g->models = m;
  g->last = m;
  return m;
}

static void prune(model_state *s, int64_t at) {
  size_t drop = 0;
  while (drop < s->nstarts && at - s->starts[drop] >= GATE_WINDOW_MS) drop++;
  if (drop) memmove(s->starts, s->starts + drop, (s->nstarts - drop) * sizeof *s->starts), s->nstarts -= drop;
}

/* The un-jittered wait before the model may take another request. */
static int64_t wait_for(model_state *s, int64_t at) {
  prune(s, at);
  int64_t wait = s->blocked_until - at > 0 ? s->blocked_until - at : 0;
  if ((int64_t)s->nstarts >= s->cap) {
    int64_t w = s->starts[0] + GATE_WINDOW_MS - at;
    if (w > wait) wait = w;
  }
  return wait;
}

/* random.int(1_000_000) / 1_000_000 */
static double unit_draw(gate *g) {
  uint32_t u = g->draw(g->ud);
  return floor((double)u / 4294967296.0 * 1000000.0) / 1000000.0;
}
static int64_t jittered(int64_t wait, double u) { return (int64_t)ceil((double)wait * (1 + u * JITTER)); }

int64_t gate_acquire(gate *g, const char *model) {
  pthread_mutex_lock(&g->lock);
  model_state *s = state_of(g, model);
  int64_t at = g->now(g->ud);
  int64_t wait = wait_for(s, at);
  double u = unit_draw(g);
  int64_t out = 0;
  if (wait == 0) {
    if (s->nstarts == s->cap_starts) {
      s->cap_starts = s->cap_starts ? s->cap_starts * 2 : 16;
      s->starts = realloc(s->starts, s->cap_starts * sizeof *s->starts);
      if (!s->starts) abort();
    }
    s->starts[s->nstarts++] = at;
  } else {
    out = jittered(wait, u);
  }
  pthread_mutex_unlock(&g->lock);
  return out;
}

void gate_record(gate *g, const char *model, int rate_limited, int64_t retry_delay_ms) {
  pthread_mutex_lock(&g->lock);
  model_state *s = state_of(g, model);
  int64_t at = g->now(g->ud);
  if (rate_limited) {
    s->consecutive429 += 1;
    s->has_clean = 0;
    prune(s, at);
    /* The refused request itself is not evidence that the limit is higher. */
    if (s->nstarts) s->nstarts--;
    int64_t admitted = (int64_t)s->nstarts;
    if (admitted >= MIN_EVIDENCE) {
      int64_t learned = (int64_t)floor((double)admitted * DECREASE);
      if (learned < s->cap) s->cap = learned;
    }
    double doubled = GATE_BASE_BLOCK_MS * pow(2, s->consecutive429 - 1);
    int64_t capped = doubled > GATE_MAX_BLOCK_MS ? GATE_MAX_BLOCK_MS : (int64_t)doubled;
    int64_t floor_ms = retry_delay_ms > 0 ? retry_delay_ms : 0;
    int64_t block = floor_ms > capped ? floor_ms : capped;
    if (at + block > s->blocked_until) s->blocked_until = at + block;
  } else {
    s->consecutive429 = 0;
    if (!s->has_clean) {
      s->has_clean = 1, s->clean_since = at;
    } else if (at - s->clean_since >= GATE_WINDOW_MS) {
      if (s->cap != GATE_NO_CAP) s->cap += 1;
      s->clean_since = at;
    }
  }
  pthread_mutex_unlock(&g->lock);
}

int64_t gate_admission_wait(gate *g) {
  pthread_mutex_lock(&g->lock);
  int64_t at = g->now(g->ud), longest = 0;
  for (model_state *s = g->models; s; s = s->next) {
    int64_t w = wait_for(s, at);
    if (w > longest) longest = w;
  }
  double u = unit_draw(g);
  pthread_mutex_unlock(&g->lock);
  return longest == 0 ? 0 : jittered(longest, u);
}

gate_state gate_inspect(gate *g, const char *model) {
  pthread_mutex_lock(&g->lock);
  model_state *s = state_of(g, model);
  prune(s, g->now(g->ud));
  gate_state out = {s->blocked_until, s->cap, (int)s->nstarts, s->consecutive429};
  pthread_mutex_unlock(&g->lock);
  return out;
}

/* ---- the process's gate ---- */
static int64_t monotonic_ms(void *ud) {
  (void)ud;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static uint32_t process_draw(void *ud) {
  (void)ud;
  return rng_uint32();
}
static pthread_once_t shared_once = PTHREAD_ONCE_INIT;
static gate *shared;
static void make_shared(void) { shared = gate_new(monotonic_ms, process_draw, NULL); }
gate *gate_shared(void) {
  pthread_once(&shared_once, make_shared);
  return shared;
}
