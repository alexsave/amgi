/* The one client amgi uses for every model call, in C: plusaudio/lib/cardGeneration/gemini.ts (the
 * request, the rate gate, the quota handling and the messages a person sees), geminiWire.ts (the
 * hand-written protobuf of the few messages amgi sends and reads) and geminiSpeech.ts (speech: the
 * voice draw and the WAV it answers). The transport is cbase's gRPC over HTTP/2 (net/grpc.h), on
 * one channel the process shares; GEMINI_API_BASE points it at a fake (cleartext HTTP/2 with prior
 * knowledge) for the tests. */
#ifndef AMGI_GEMINI_H
#define AMGI_GEMINI_H
#include <stddef.h>
#include <stdint.h>

#include "../collection/util.h"
#include "gate.h"

/* What a failure is, as gemini.ts's error classes and plusaudioCli.js's exit codes make it:
 *   GE_ERROR  a plain Error (retryable inside the audio loop; a 500 at the route)
 *   GE_FATAL  GeminiUnavailableError: no retry can fix it (rethrown at once; a 500 at the route)
 *   GE_DAILY  GeminiDailyCapError: fatal, and a 429 {dailyCap} at the route
 *   GE_RATE   GeminiRateLimitError: a wait longer than one request sits through; a 429 {retryAfterMs} */
enum { GE_OK = 0, GE_ERROR, GE_FATAL, GE_DAILY, GE_RATE };
typedef struct {
  int kind;
  str message;
  int64_t retry_after_ms;
} gem_err;
void gem_fail(arena *a, gem_err *e, int kind, const char *fmt, ...) __attribute__((format(printf, 4, 5)));

/* A request: built by the caller (cards.c), encoded by gem_encode. */
typedef struct {
  str text;               /* a text part, or none (text.p NULL) */
  const void *audio;      /* an inlineData part (audio/wav), or NULL */
  size_t audio_len;
} gem_part;
typedef struct {
  const char *system;   /* systemInstruction's one text part, or NULL */
  const char *role;     /* the content's role, or NULL */
  gem_part parts[2];
  int nparts;
  const buf *schema;    /* a google.protobuf.Value: responseMimeType application/json and responseJsonSchema */
  int thinking;         /* thinkingConfig.thinkingLevel LOW */
  const char *voice;    /* speech: responseModalities [AUDIO] and this prebuilt voice */
} gem_request;
void gem_encode(buf *out, const char *model, const gem_request *r);

/* What amgi reads of a GenerateContentResponse: the first candidate's parts and finish reason. */
typedef struct {
  int has_text;
  str text;
  int thought;
  int has_inline, has_data;
  str mime, data;
} gem_part_out;
typedef struct {
  gem_part_out *parts;
  size_t nparts;
  str finish_reason; /* an enum name, its number, or empty (none) */
} gem_response;
/* responseText: the answer's text without thought parts, joined and trimmed. */
str gem_response_text(arena *a, const gem_response *r);

/* ---- google.protobuf.Value, for responseJsonSchema ---- */
void gv_string(buf *b, const char *s);
void gv_bool(buf *b, int v);
/* A struct: begin, then key + value pairs, then end. Values nest. */
void gv_field(buf *structbody, const char *key, const buf *value); /* one entry of a Struct's body */
void gv_struct_of(buf *b, const buf *body);                         /* Value{struct_value: body} */
void gv_list_of(buf *b, const buf *items);                          /* Value{list_value: items} */
void gv_list_item(buf *items, const buf *value);

/* ---- the client ---- */
/* Opens the process's channel to GEMINI_API_BASE (or Google's endpoint). 0, or -1 with err. */
int gem_open(char *err, size_t cap);
void gem_close(void);
/* createGeminiClient's generateContent: through the gate, one unary call, the quota and status
 * rules. 0 and *out, or -1 with *e. */
int gem_generate(arena *a, const char *model, const gem_request *req, gem_response *out, gem_err *e);
/* For tests: the gate the client asks (the process's by default). */
void gem_set_gate(gate *g);

/* ---- speech (geminiSpeech.ts) ---- */
/* pickVoice: drawn from the pool, never the previous attempt's (NULL for none). */
const char *gem_pick_voice(const char *previous);
/* synthesize: one clip as a whole WAV file. */
int gem_synthesize(arena *a, str text, const char *voice, str *wav, gem_err *e);
/* audioPartToWav and pcmToWav, for tests. */
int gem_audio_to_wav(arena *a, str mime, str bytes, str *wav, str *error);
str gem_pcm_to_wav(arena *a, str pcm, uint32_t rate, uint32_t channels);

/* gemini.ts dailyQuotaMessage */
str gem_daily_quota_message(arena *a, const char *model, int free_tier, int has_limit, double limit, int has_resets,
                            int64_t resets_in_ms);
#endif
