/* The amgi app on cbase serve: what replaces ui/server/serve.mjs and the route modules under src/server/api/anki.
 *
 * It is one product library (server/Makefile's APP_EXTRA_SRC, beside the collection core), and
 * server/app/amgi_app.c only declares the cb_app over it. The pieces:
 *   web.c       a request's settings headers, the wire answers, the plain answers, query strings and
 *               JavaScript's Number() (ui/server/serve.mjs, settings.js, respond.js)
 *   ops.c       the transport's ops, direct or bridge, behind one call each (transport.js)
 *   routes.c    every /api/anki route, the page's files and the clip route
 *   install.c   install.js, the file half in C and the collection half on the core
 *   starter.c   starterDeck.js and starterPhrases.js
 *   gate.c      plusaudio/lib/rateGate.js, the one rate gate of the process
 *   gemini*.c   the Gemini client (gemini.ts, geminiWire.ts, geminiSpeech.ts) on cbase's gRPC
 *   cards.c     the card generation flow (cardGeneration.ts, cardPrompts.ts, cardText.ts, sideOrder.js,
 *               audio.js, cardText.js)
 *
 * Every string a person reads has one owner here (messages.h). The JavaScript named in each file's
 * header is what it was ported from, removed at L4. */
#ifndef AMGI_APP_H
#define AMGI_APP_H
#include <stddef.h>
#include <stdint.h>

#include "../collection/bridge.h"
#include "../collection/collection.h"
#include "../collection/util.h"
#include "net/http.h"
#include "wire.h"

/* ---- web.c ---- */
/* What a request's five X-Amgi-* headers say (settings.js): each percent-decoded, a malformed escape
 * read as empty. */
typedef struct {
  str base_dir_override, collection_path, profile_name, bridge_url, bridge_token;
} amgi_settings;
void amgi_read_settings(arena *a, const cb_http_req *req, amgi_settings *out);
col_settings amgi_col_settings(const amgi_settings *s);

/* decodeURIComponent: 1 and *out, or 0 when it would throw (a bad escape, bytes that are not UTF-8). */
int amgi_uri_decode(arena *a, str raw, str *out);
/* URLSearchParams.get: 1 and the first value (decoded as the WHATWG URL parser does), or 0 for none. */
int amgi_query_get(arena *a, const char *query, const char *key, str *out);
/* JavaScript's Number(string). */
double amgi_js_number(str s);
/* A matched route's path parameter, raw (as the path spells it). */
str amgi_param(const cb_http_req *req, const char *name);

/* The answers. Every API answer carries Cache-Control: no-store, as serve.mjs's send does. */
void amgi_send_text(cb_http_res *res, int status, str text);
void amgi_send_wire(arena *a, cb_http_res *res, int status, uint32_t kind, const void *msg);
/* An error-kind answer: mode is a transport mode name or NULL. */
typedef struct {
  const char *mode;
  str error;
  int has_retry;          /* retryAfterMs and maxWaitMs, and a Retry-After header */
  uint32_t retry_after_ms;
  int not_started, daily_cap;
} amgi_error;
void amgi_send_error(arena *a, cb_http_res *res, int status, const amgi_error *e);
void amgi_send_message(arena *a, cb_http_res *res, int status, str message); /* {error: message} */
/* respond.js notReadyResponse: 409 with the mode and its sentence. */
void amgi_not_ready(arena *a, cb_http_res *res, const char *mode);

/* JS number -> wire u32, as wire_node.c's to_u32 writes one. */
uint32_t amgi_u32(double v);
wire_str amgi_ws(str s);
str amgi_str(wire_str w);

/* ---- ops.c: transport.js's ops ---- */
typedef struct {
  const col_transport *t;
  str path; /* the collection file, for the direct transport */
} amgi_ops;
int ops_is_direct(const amgi_ops *o);
int ops_list_decks(arena *a, const amgi_ops *o, col_deck **out, size_t *n, col_err *e);
int ops_count_notes(arena *a, const amgi_ops *o, double deck, int64_t *out, col_err *e);
int ops_list_notetypes(arena *a, const amgi_ops *o, col_notetype **out, size_t *n, col_err *e);
int ops_list_notes(arena *a, const amgi_ops *o, double deck, double offset, double limit, col_page *out, col_err *e);
int ops_field_values(arena *a, const amgi_ops *o, double deck, double nt, double field, str **out, size_t *n, col_err *e);
int ops_create_deck(arena *a, const amgi_ops *o, str name, col_deck_made *out, col_err *e);
int ops_rename_deck(arena *a, const amgi_ops *o, double deck, str name, int64_t *id, str *out_name, col_err *e);
int ops_removal_summary(arena *a, const amgi_ops *o, double deck, col_removal *out, col_err *e);
int ops_remove_deck(arena *a, const amgi_ops *o, double deck, col_removal *out, col_err *e);
int ops_add_note(arena *a, const amgi_ops *o, const col_new_note *note, col_added *out, col_err *e);
int ops_add_notes(arena *a, const amgi_ops *o, const col_new_note *notes, size_t n, col_added **out, size_t *nout,
                  col_err *e);
/* has_note_id: the transport named the note (the bridge does); else the route's own id stands. */
int ops_update_note(arena *a, const amgi_ops *o, double note, const str *fields, size_t nfields, int has_language,
                    str language, int has_lfi, double lfi, int *has_note_id, int64_t *note_id, int *has_warning,
                    str *warning, col_err *e);
int ops_remove_note(arena *a, const amgi_ops *o, double note, int64_t *note_id, col_err *e);
int ops_has_media(arena *a, const amgi_ops *o, str name, int *out, col_err *e);
int ops_read_media(arena *a, const amgi_ops *o, str name, int *found, str *bytes, col_err *e);
int ops_add_media(arena *a, const amgi_ops *o, str name, const void *data, size_t len, str *stored, col_err *e);

/* ---- the repository's root: where the add-ons, the card type, the starter deck and the page's files
 * are read from. The working directory, as install.js's repoRoot() and serve.mjs's start agree on
 * (the drives and the parity suite start the server there). ---- */
str amgi_root(arena *a);

/* ---- install.c ---- */
void amgi_install_get(arena *a, const amgi_settings *s, cb_http_res *res);
void amgi_install_post(arena *a, const amgi_settings *s, str body_override, cb_http_res *res);
/* The collection half on its own, for the collection runner (collection_cli): collectionDrift (1 when
 * checked, and what is stale), and installNotetypeDirect (1 when the note type is there now; *made
 * says what the core answered). */
int amgi_collection_drift(arena *a, const amgi_ops *o, str root, str **stale, size_t *n);
int amgi_install_notetype(arena *a, const amgi_ops *o, str root, col_notetype_made *made);
/* Where the profiles are (transport.js discoverProfiles). */
str amgi_base_dir(arena *a, str override);

/* ---- starter.c ---- */
void amgi_starter_get(arena *a, cb_http_res *res);
/* buildStarterDeck: 0 and the answer, or -1 with *message (a 400). */
typedef struct { int64_t deck_id; str deck_name; uint32_t added, already_there; } amgi_starter_built;
int amgi_starter_build(arena *a, const amgi_ops *o, str known, str learning, str deck_name, amgi_starter_built *out,
                       str *message);
/* fieldIndexes (src/utils/amgiNotetype.js) */
typedef struct { int cue, cue_audio, target, target_audio, language, notes; } amgi_fields;
amgi_fields amgi_field_indexes(arena *a, const col_notetype *nt);

/* ---- gen.c: POST /card-text and POST /audio ---- */
void amgi_card_text(arena *a, const amgi_ops *o, const char *mode, const wire_q_card_text *q, cb_http_res *res);
void amgi_audio(arena *a, const amgi_ops *o, const char *mode, const wire_q_audio *q, cb_http_res *res);
/* The Gemini channel and the gate: opened at serve_open, closed at serve_close. */
int amgi_gen_open(char *err, size_t cap);
void amgi_gen_close(void);
int amgi_generation_available(void); /* Boolean(process.env.GEMINI_API_KEY) */

/* ---- media names (plusaudio/lib/audio-store.js) and the reference a field holds (deck.js) ---- */
str amgi_media_name(arena *a, str text, str language, const char *extension);
str amgi_audio_reference(arena *a, str filename);

#endif
