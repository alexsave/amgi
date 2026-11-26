/* lib/rateGate.js in C: the one rate gate the process shares between every Gemini call
 * in it, asked before each request how long to wait and told after each answer whether it was
 * refused. rateGate.js's header has the policy, kept number for number:
 *   - a 429 blocks the model for a doubling backoff from 2 s up to 180 s (MAX_WAIT_MS), with
 *     Google's retryDelay as the floor (which may pass the cap);
 *   - it learns a per-minute cap, 80% of what got through in the last minute, once at least three
 *     did, and then probes above it, one more at a time: a probe that holds a clean minute is the
 *     new level, and the next probe follows. A probe that is refused is a limit found: the cap goes
 *     back to the last level that held, and the wait there before the next probe doubles (1 minute,
 *     2, 4, ... up to GATE_MAX_GROW_MS), so a run against a fixed limit is refused less and less
 *     often. When the limit is raised, the next probe holds and the cap climbs again a step a minute.
 *     No limit is taken from Google's answer;
 *   - a refusal at a level that held before means the limit was lowered: the 80% rule again;
 *   - every wait it gives is jittered up to 25%, from the one seedable random source, with exactly
 *     one draw per acquire and per admission_wait whether or not it waits;
 *   - admission_wait says how long until new work may start, and records nothing.
 * The clock and the draw are injected; the process's gate uses a monotonic clock and rng.c. Calls
 * are plain function calls, safe from any thread (one lock). */
#ifndef AMGI_GATE_H
#define AMGI_GATE_H
#include <stdint.h>

#define GATE_WINDOW_MS 60000
#define GATE_BASE_BLOCK_MS 2000
#define GATE_MAX_BLOCK_MS 180000
#define GATE_MAX_GROW_MS 3840000 /* 64 minutes between probes at most */
#define GATE_NO_CAP INT64_MAX /* Infinity: no limit learned */

typedef struct gate gate;
typedef int64_t (*gate_clock)(void *ud);
typedef uint32_t (*gate_draw)(void *ud); /* one uint32 draw */

gate *gate_new(gate_clock now, gate_draw draw, void *ud);
void gate_free(gate *g);
/* The process's gate (made on first use). */
gate *gate_shared(void);

/* 0: go now (the start is counted); else the jittered wait in ms. */
int64_t gate_acquire(gate *g, const char *model);
/* After an answer: rate_limited, with Google's retryDelay (or < 0 for none), or a success. */
void gate_record(gate *g, const char *model, int rate_limited, int64_t retry_delay_ms);
int64_t gate_admission_wait(gate *g);

/* good: the last cap that held a whole interval (-1: none yet); grow_every: the interval before the next probe. */
typedef struct { int64_t blocked_until, cap, good, grow_every; int in_window, consecutive429; } gate_state;
gate_state gate_inspect(gate *g, const char *model);
#endif
