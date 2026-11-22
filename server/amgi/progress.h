/* What each card being made is doing now, for the page to show (GET /progress). A request that named
 * itself (q_card_text's progressId) holds an entry from its start to its answer; the code that does the
 * work says each step as it begins it. Every call takes NULL, for work nobody watches (a clip recorded
 * again, amgi-clip). One lock, held for a copy; nothing here waits on anything else. */
#ifndef AMGI_PROGRESS_H
#define AMGI_PROGRESS_H
#include <stdint.h>

#include "../collection/util.h"
#include "wire.h"

#define PROGRESS_MAX 64 /* watched at once: more than amgi_app.c's slow_workers */

typedef struct progress progress;

/* An entry for id, or NULL (id 0, or the table is full: the card is made all the same, unwatched). */
progress *progress_begin(uint32_t id);
/* The entry goes. It comes before the arena that holds progress_texts' strings is freed. */
void progress_end(progress *p);

/* take of takes, or 0 of 0 for a step that has none. */
void progress_writing(progress *p, uint32_t take, uint32_t takes);
/* Both sides, once they are final. Not copied: they live until progress_end. */
void progress_texts(progress *p, str front, str back);
/* The side the audio steps after this are for. */
void progress_side(progress *p, int cue);
enum { AUDIO_REUSE, AUDIO_RECORDING, AUDIO_TRANSCRIBING, AUDIO_JUDGING, AUDIO_STORING, AUDIO_STEPS };
void progress_audio(progress *p, int audio_step, uint32_t take, uint32_t takes);
/* The step waits ms for Gemini's limit; 0: the wait is over. The step itself stays. */
void progress_wait(progress *p, int64_t ms);

/* Every entry now, copied into a. */
wire_progress progress_list(arena *a);

#endif
