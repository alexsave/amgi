/* Every route the amgi server answers, as the Node server (ui/server/serve.mjs and src/server/api/anki, removed at L4) answered
 * them.
 *
 * Each /api/anki route is a cbase route (its method, its pattern with :parameters, and its body cap),
 * whose handler reads its parameters raw from the matched route (cb_http_req params) and runs the
 * route's body through the same steps serve.mjs did: the content type (415), the wire decode (400),
 * then the handler. Two catch-alls stand behind them for what cbase's router alone would answer
 * differently from Node:
 *   - "* /api/anki/...": serve.mjs matched the path's segments after dropping empty ones, so
 *     "/api/anki/decks/" was the decks route; a path no route has is 404 "no such route", and a
 *     route without that method 501 "no wire layout for ...". The fallback matches exactly as
 *     serve.mjs did and runs the same handler.
 *   - "* /...": the page's files and the 404 "not found" of everything else.
 * cbase answers OPTIONS itself (a preflight): from any origin it is 403 with no Access-Control-*
 * header, where Node answered 501. That is the one difference, and the parity suite names it.
 *
 * Files are read from disk on every request (a rebuild is picked up without a restart), through
 * cbase's cb_send_file. */
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "amgi.h"
#include "messages.h"
#include "cbase/app.h"
#include "net/files.h"
#include "util/err.h"

/* serveFile: the file with its type and no-store, read when it is asked for (cbase's cb_send_file
 * opens it per request, so a rebuild is what the next request gets). A file that is not there is
 * 404 "not found", as serve.mjs answered it. */
static void serve_file(arena *a, cb_ctx *ctx, const cb_http_req *req, cb_http_res *res, str rel, const char *type) {
  const char *path = str_z(a, path_join(a, amgi_root(a), rel));
  struct stat sb;
  if (stat(path, &sb) != 0 || !S_ISREG(sb.st_mode)) {
    amgi_send_text(res, 404, S("not found"));
    return;
  }
  cb_send_file(ctx, req, res, path, type, "no-store");
}

/* ---- the routes' shared start ---- */
typedef struct {
  arena *a;
  cb_ctx *ctx;
  const cb_http_req *req;
  cb_http_res *res;
  const str *params; /* the route's parameters, raw, in pattern order */
  const void *body;  /* the decoded request kind's struct, or NULL */
  amgi_settings s;
  col_transport t;
  amgi_ops o;
} rq;

/* resolveTransport, then notReadyResponse when there are no ops: 1 to go on. A status that threw
 * is the request's failure (serve.mjs's 500). */
static int resolve(rq *q) {
  col_settings cs = amgi_col_settings(&q->s);
  col_err e = {0};
  if (col_resolve_transport(q->a, &cs, &q->t, &e) < 0) {
    amgi_send_text(q->res, 500, e.message);
    return 0;
  }
  q->o.t = &q->t;
  q->o.path = q->s.collection_path;
  return 1;
}
static int ready(rq *q) {
  if (!resolve(q)) return 0;
  if (!q->t.ops) {
    amgi_not_ready(q->a, q->res, q->t.mode);
    return 0;
  }
  return 1;
}
static uint32_t mode_of(const rq *q) { return wire_mode_of(q->t.mode, (uint32_t)strlen(q->t.mode)); }
/* An error nothing in the handler caught: serve.mjs's 500 with the message as text. */
static void fail500(rq *q, const col_err *e) { amgi_send_text(q->res, 500, e->message); }
static void fail400(rq *q, const col_err *e) { amgi_send_message(q->a, q->res, 400, e->message); }

static wire_strs strs_of(arena *a, const str *v, size_t n) {
  wire_strs w = {ar_alloc(a, (n + 1) * sizeof(wire_str)), (uint32_t)n};
  for (size_t i = 0; i < n; i++) w.v[i] = amgi_ws(v[i]);
  return w;
}
static str *strs_from(arena *a, wire_strs w) {
  str *v = ar_alloc(a, (w.n + 1) * sizeof(str));
  for (uint32_t i = 0; i < w.n; i++) v[i] = amgi_str(w.v[i]);
  return v;
}
/* A q_note as the ops take it: what the wire decodes to in JavaScript (a missing language is "", a
 * missing learning field index is absent). */
static col_new_note new_note(arena *a, const wire_q_note *n) {
  col_new_note c = {0};
  c.deck_id = (double)n->deck_id;
  c.notetype_id = (double)n->notetype_id;
  c.fields = strs_from(a, n->fields);
  c.nfields = n->fields.n;
  c.tags = strs_from(a, n->tags);
  c.ntags = n->tags.n;
  c.has_language = 1;
  c.language = amgi_str(n->language);
  c.has_learning_field = n->learning_field_index != WIRE_ABSENT;
  c.learning_field = n->learning_field_index;
  return c;
}

/* ---- the handlers ---- */
static void h_status(rq *q) {
  if (!resolve(q)) return;
  wire_status w = {mode_of(q), q->t.has_schema ? (uint32_t)q->t.schema : 0, {"", 0}};
  amgi_send_wire(q->a, q->res, 200, WK_STATUS, &w);
}

static void h_decks_get(rq *q) {
  if (!ready(q)) return;
  col_deck *d;
  size_t n;
  col_err e = {0};
  if (ops_list_decks(q->a, &q->o, &d, &n, &e)) return fail500(q, &e);
  wire_decks w = {mode_of(q), ar_alloc(q->a, (n + 1) * sizeof(wire_deck)), (uint32_t)n};
  for (size_t i = 0; i < n; i++) {
    int64_t count;
    if (ops_count_notes(q->a, &q->o, (double)d[i].id, &count, &e)) return fail500(q, &e);
    w.decks[i] = (wire_deck){d[i].id, amgi_ws(d[i].name), amgi_u32((double)count)};
  }
  amgi_send_wire(q->a, q->res, 200, WK_DECKS, &w);
}

static void h_decks_post(rq *q) {
  if (!ready(q)) return;
  const wire_q_deck_name *b = q->body;
  str name = js_trim(amgi_str(b->name));
  if (!name.n) return amgi_send_message(q->a, q->res, 400, S("a deck name is required"));
  col_deck_made d;
  col_err e = {0};
  if (ops_create_deck(q->a, &q->o, name, &d, &e)) return fail400(q, &e);
  wire_deck_created w = {mode_of(q), d.id, amgi_ws(d.name), (uint8_t)(d.created ? 1 : 0)};
  amgi_send_wire(q->a, q->res, 200, WK_DECK_CREATED, &w);
}

static void h_deck_patch(rq *q) {
  if (!ready(q)) return;
  const wire_q_deck_name *b = q->body;
  str name = js_trim(amgi_str(b->name));
  if (!name.n) return amgi_send_message(q->a, q->res, 400, S("name is required"));
  int64_t id;
  str out;
  col_err e = {0};
  if (ops_rename_deck(q->a, &q->o, amgi_js_number(q->params[0]), name, &id, &out, &e)) return fail400(q, &e);
  wire_deck_renamed w = {mode_of(q), id, amgi_ws(out)};
  amgi_send_wire(q->a, q->res, 200, WK_DECK_RENAMED, &w);
}

/* decks/[id]/route.js failed(): a deck that is not there is 404, the rest 400. */
static void deck_failed(rq *q, const col_err *e) {
  if (e->status == 404) return amgi_send_message(q->a, q->res, 404, S("This deck no longer exists."));
  fail400(q, e);
}
static void h_deck_get(rq *q) {
  if (!ready(q)) return;
  col_removal r;
  col_err e = {0};
  if (ops_removal_summary(q->a, &q->o, amgi_js_number(q->params[0]), &r, &e)) return deck_failed(q, &e);
  wire_deck_summary w = {mode_of(q), r.id, amgi_ws(r.name), amgi_u32((double)r.subdecks), amgi_u32((double)r.cards),
                         amgi_u32((double)r.notes)};
  amgi_send_wire(q->a, q->res, 200, WK_DECK_SUMMARY, &w);
}
static void h_deck_delete(rq *q) {
  if (!ready(q)) return;
  col_removal r;
  col_err e = {0};
  if (ops_remove_deck(q->a, &q->o, amgi_js_number(q->params[0]), &r, &e)) return deck_failed(q, &e);
  wire_deck_removed w = {mode_of(q), r.id, amgi_ws(r.name), amgi_u32((double)r.decks), amgi_u32((double)r.cards),
                         amgi_u32((double)r.notes)};
  amgi_send_wire(q->a, q->res, 200, WK_DECK_REMOVED, &w);
}

/* Number(searchParams.get(key)): a missing parameter is Number(null), 0. */
static double query_number(rq *q, const char *key) {
  str v;
  return amgi_query_get(q->a, q->req->query, key, &v) ? amgi_js_number(v) : 0;
}

static void h_notes(rq *q) {
  if (!ready(q)) return;
  double offset = query_number(q, "offset"), limit = query_number(q, "limit");
  if (offset != offset || offset == 0) offset = 0; /* Number(...) || 0 */
  offset = fmax(0, offset);
  if (limit != limit || limit == 0) limit = 50; /* Number(...) || DEFAULT_LIMIT */
  limit = fmin(200, fmax(1, limit));
  col_page p;
  col_err e = {0};
  if (ops_list_notes(q->a, &q->o, amgi_js_number(q->params[0]), offset, limit, &p, &e)) return fail500(q, &e);
  wire_notes w = {mode_of(q), ar_alloc(q->a, (p.n + 1) * sizeof(wire_note)), (uint32_t)p.n, amgi_u32(p.offset),
                  amgi_u32(p.limit), (uint8_t)(p.has_more ? 1 : 0)};
  for (size_t i = 0; i < p.n; i++) {
    const col_note *n = &p.notes[i];
    w.notes[i] = (wire_note){n->id, n->notetype_id, strs_of(q->a, n->fields, n->nfields), strs_of(q->a, n->tags, n->ntags)};
  }
  amgi_send_wire(q->a, q->res, 200, WK_NOTES, &w);
}

/* field-values/route.js wholeNumber: digits only, or nothing. */
static int whole_number(rq *q, const char *key, double *out) {
  str v;
  if (!amgi_query_get(q->a, q->req->query, key, &v) || !v.n) return 0;
  for (size_t i = 0; i < v.n; i++)
    if (v.p[i] < '0' || v.p[i] > '9') return 0;
  *out = amgi_js_number(v);
  return 1;
}
static void h_field_values(rq *q) {
  double nt = 0, field = 0;
  int has_nt = whole_number(q, "notetypeId", &nt), has_field = whole_number(q, "fieldIndex", &field);
  if (!has_nt || !has_field) {
    const char *which = !has_nt && !has_field ? "notetypeId and fieldIndex" : !has_nt ? "notetypeId" : "fieldIndex";
    return amgi_send_message(q->a, q->res, 400, str_c(ar_fmt(q->a, "%s must be given, as a whole number", which)));
  }
  if (!ready(q)) return;
  str *v;
  size_t n;
  col_err e = {0};
  if (ops_field_values(q->a, &q->o, amgi_js_number(q->params[0]), nt, field, &v, &n, &e)) return fail500(q, &e);
  wire_field_values w = {mode_of(q), strs_of(q->a, v, n)};
  amgi_send_wire(q->a, q->res, 200, WK_FIELD_VALUES, &w);
}

static void h_install_get(rq *q) { amgi_install_get(q->a, &q->s, q->res); }
static void h_install_post(rq *q) {
  const wire_q_install *b = q->body;
  amgi_install_post(q->a, &q->s, amgi_str(b->base_dir_override), q->res);
}

static void h_profiles(rq *q) {
  str base = amgi_base_dir(q->a, q->s.base_dir_override);
  struct stat sb;
  int exists = stat(str_z(q->a, base), &sb) == 0;
  size_t n = 0;
  col_profile *p = exists ? col_list_profiles(q->a, base, &n) : NULL;
  wire_profiles w = {amgi_ws(base), (uint8_t)exists, ar_alloc(q->a, (n + 1) * sizeof(wire_profile)), (uint32_t)n};
  for (size_t i = 0; i < n; i++) w.profiles[i] = (wire_profile){amgi_ws(p[i].name), amgi_ws(p[i].collection_path)};
  amgi_send_wire(q->a, q->res, 200, WK_PROFILES, &w);
}

static void h_notetypes(rq *q) {
  if (!ready(q)) return;
  col_notetype *nt;
  size_t n;
  col_err e = {0};
  if (ops_list_notetypes(q->a, &q->o, &nt, &n, &e)) return fail500(q, &e);
  wire_notetypes w = {mode_of(q), ar_alloc(q->a, (n + 1) * sizeof(wire_notetype)), (uint32_t)n};
  for (size_t i = 0; i < n; i++)
    w.notetypes[i] = (wire_notetype){nt[i].id, amgi_ws(nt[i].name), strs_of(q->a, nt[i].fields, nt[i].nfields),
                                     amgi_u32((double)nt[i].sort_field)};
  amgi_send_wire(q->a, q->res, 200, WK_NOTETYPES, &w);
}

static void h_notes_post(rq *q) {
  if (!ready(q)) return;
  const wire_q_note *b = q->body;
  /* Array.isArray(fields) always holds: the wire decodes a list, empty or not. */
  if (!b->deck_id || !b->notetype_id) return amgi_send_message(q->a, q->res, 400, S("deckId, notetypeId and fields are required"));
  col_new_note note = new_note(q->a, b);
  col_added r;
  col_err e = {0};
  if (ops_add_note(q->a, &q->o, &note, &r, &e)) return fail400(q, &e);
  wire_note_added w = {mode_of(q), r.note_id};
  amgi_send_wire(q->a, q->res, 200, WK_NOTE_ADDED, &w);
}

static void h_notes_bulk(rq *q) {
  if (!ready(q)) return;
  const wire_q_notes *b = q->body;
  if (!b->nnotes) return amgi_send_message(q->a, q->res, 400, S("notes must be a non-empty array"));
  for (uint32_t i = 0; i < b->nnotes; i++)
    if (!b->notes[i].deck_id || !b->notes[i].notetype_id)
      return amgi_send_message(q->a, q->res, 400, S("each note requires deckId, notetypeId and fields"));
  col_new_note *notes = ar_alloc(q->a, (b->nnotes + 1) * sizeof *notes);
  for (uint32_t i = 0; i < b->nnotes; i++) notes[i] = new_note(q->a, &b->notes[i]);
  col_added *r;
  size_t nr;
  col_err e = {0};
  if (ops_add_notes(q->a, &q->o, notes, b->nnotes, &r, &nr, &e)) return fail400(q, &e);
  wire_notes_added w = {mode_of(q), ar_alloc(q->a, (nr + 1) * sizeof(wire_note_result)), (uint32_t)nr};
  for (size_t i = 0; i < nr; i++)
    w.results[i] = (wire_note_result){(uint8_t)(r[i].ok ? 1 : 0), r[i].ok ? r[i].note_id : 0,
                                      amgi_ws(r[i].ok ? S("") : r[i].error)};
  amgi_send_wire(q->a, q->res, 200, WK_NOTES_ADDED, &w);
}

static void h_note_patch(rq *q) {
  if (!ready(q)) return;
  const wire_q_note_update *b = q->body;
  double id = amgi_js_number(q->params[0]);
  int has_id, has_w;
  int64_t note_id = 0;
  str warning = {0};
  col_err e = {0};
  if (ops_update_note(q->a, &q->o, id, strs_from(q->a, b->fields), b->fields.n, 1, amgi_str(b->language),
                      b->learning_field_index != WIRE_ABSENT, b->learning_field_index, &has_id, &note_id, &has_w, &warning,
                      &e))
    return fail400(q, &e);
  wire_note_changed w = {mode_of(q), has_id ? note_id : (id != id ? 0 : (int64_t)id), amgi_ws(has_w ? warning : S(""))};
  amgi_send_wire(q->a, q->res, 200, WK_NOTE_CHANGED, &w);
}

static void h_note_delete(rq *q) {
  if (!ready(q)) return;
  int64_t note_id;
  col_err e = {0};
  if (ops_remove_note(q->a, &q->o, amgi_js_number(q->params[0]), &note_id, &e)) return fail400(q, &e);
  wire_note_changed w = {mode_of(q), note_id, {"", 0}};
  amgi_send_wire(q->a, q->res, 200, WK_NOTE_CHANGED, &w);
}

static void h_card_text(rq *q) {
  if (!ready(q)) return;
  amgi_card_text(q->a, &q->o, q->t.mode, q->body, q->res);
}
static void h_audio(rq *q) {
  if (!ready(q)) return;
  amgi_audio(q->a, &q->o, q->t.mode, q->body, q->res);
}

static void h_starter_get(rq *q) { amgi_starter_get(q->a, q->res); }
static void h_starter_post(rq *q) {
  if (!ready(q)) return;
  const wire_q_starter *b = q->body;
  str known = amgi_str(b->known), learning = amgi_str(b->learning), name = js_trim(amgi_str(b->name));
  if (!known.n || !learning.n) return amgi_send_message(q->a, q->res, 400, S("known and learning languages are required"));
  if (!name.n) name = S("amgi starter");
  amgi_starter_built r;
  str message;
  if (amgi_starter_build(q->a, &q->o, known, learning, name, &r, &message)) return amgi_send_message(q->a, q->res, 400, message);
  wire_starter_built w = {mode_of(q), r.deck_id, amgi_ws(r.deck_name), r.added, r.already_there};
  amgi_send_wire(q->a, q->res, 200, WK_STARTER_BUILT, &w);
}

/* mediaType.js contentTypeFor */
static const char *media_type(str name) {
  static const struct { const char *ext, *type; } TYPES[] = {
    {".mp3", "audio/mpeg"}, {".wav", "audio/wav"}, {".ogg", "audio/ogg"}, {".m4a", "audio/mp4"}};
  const char *dot = NULL;
  for (size_t i = 0; i < name.n; i++)
    if (name.p[i] == '.') dot = name.p + i;
  if (!dot) return "application/octet-stream";
  size_t n = (size_t)(name.p + name.n - dot);
  for (size_t t = 0; t < sizeof TYPES / sizeof *TYPES; t++)
    if (n == strlen(TYPES[t].ext) && !strncasecmp(dot, TYPES[t].ext, n)) return TYPES[t].type;
  return "application/octet-stream";
}

static void h_media(rq *q) {
  str name;
  if (!amgi_uri_decode(q->a, q->params[0], &name))
    return amgi_send_message(q->a, q->res, 400, S("the clip name is not a valid name"));
  if (!ready(q)) return;
  const char *type = media_type(name);
  const char *cache = "private, max-age=31536000, immutable";
  if (ops_is_direct(&q->o)) {
    /* The collection core says what is a clip (col_media_path: one name in the media folder, no
     * link followed, a regular file of at most 256 MiB, the rule hasMedia and readMedia share), and
     * cbase sends it. */
    int found = 0;
    str file = {0};
    col_err e = {0};
    if (col_media_path(q->a, q->o.path, name, &found, &file, &e)) return fail500(q, &e);
    if (!found) return amgi_send_text(q->res, 404, S("no such clip"));
    cb_send_file(q->ctx, q->req, q->res, file.p, type, cache);
    return;
  }
  /* Through the bridge the add-on reads the clip, as Node asked it to. */
  int found = 0;
  str bytes = {0};
  col_err e = {0};
  if (ops_read_media(q->a, &q->o, name, &found, &bytes, &e)) return fail500(q, &e);
  if (!found) return amgi_send_text(q->res, 404, S("no such clip"));
  cb_res_send(q->res, 200, type, bytes.p, bytes.n);
  cb_res_header(q->res, "Cache-Control", cache);
}

/* ---- the table: serve.mjs's ROUTES, each a cbase route ---- */
typedef struct {
  const char *method;
  const char *shape;   /* the path after /api/anki/, ":x" a parameter */
  const char *pattern; /* the cbase pattern: /api/anki/<shape> */
  int32_t body;        /* the request kind, or -1 */
  void (*fn)(rq *);
} amgi_route;

static const amgi_route ROUTES[] = {
  {"GET", "status", "/api/anki/status", -1, h_status},
  {"GET", "decks", "/api/anki/decks", -1, h_decks_get},
  {"POST", "decks", "/api/anki/decks", WK_Q_DECK_NAME, h_decks_post},
  {"PATCH", "decks/:id", "/api/anki/decks/:id", WK_Q_DECK_NAME, h_deck_patch},
  {"GET", "decks/:id", "/api/anki/decks/:id", -1, h_deck_get},
  {"DELETE", "decks/:id", "/api/anki/decks/:id", -1, h_deck_delete},
  {"GET", "decks/:id/notes", "/api/anki/decks/:id/notes", -1, h_notes},
  {"GET", "decks/:id/notes/field-values", "/api/anki/decks/:id/notes/field-values", -1, h_field_values},
  {"GET", "install", "/api/anki/install", -1, h_install_get},
  {"POST", "install", "/api/anki/install", WK_Q_INSTALL, h_install_post},
  {"GET", "profiles", "/api/anki/profiles", -1, h_profiles},
  {"GET", "notetypes", "/api/anki/notetypes", -1, h_notetypes},
  {"POST", "notes", "/api/anki/notes", WK_Q_NOTE, h_notes_post},
  {"POST", "notes/bulk", "/api/anki/notes/bulk", WK_Q_NOTES, h_notes_bulk},
  {"PATCH", "notes/:id", "/api/anki/notes/:id", WK_Q_NOTE_UPDATE, h_note_patch},
  {"DELETE", "notes/:id", "/api/anki/notes/:id", -1, h_note_delete},
  {"POST", "card-text", "/api/anki/card-text", WK_Q_CARD_TEXT, h_card_text},
  {"POST", "audio", "/api/anki/audio", WK_Q_AUDIO, h_audio},
  {"GET", "starter", "/api/anki/starter", -1, h_starter_get},
  {"POST", "starter", "/api/anki/starter", WK_Q_STARTER, h_starter_post},
  {"GET", "media/:filename", "/api/anki/media/:filename", -1, h_media},
};
#define NROUTES (sizeof ROUTES / sizeof *ROUTES)

/* What serve.mjs's api() did once a route matched: the body's type and decode, then the handler. */
static void run(cb_ctx *ctx, const amgi_route *r, const str *params, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  rq q = {.a = &a, .ctx = ctx, .req = req, .res = res, .params = params};
  if (r->body >= 0) {
    const char *type = cb_http_header_get(req, "content-type");
    if (!type || strncmp(type, WIRE_MIME, strlen(WIRE_MIME)) != 0) {
      amgi_send_message(&a, res, 415, S("send the body as " WIRE_MIME));
      ar_free(&a);
      return;
    }
    uint32_t len = (uint32_t)req->body_len, room = wire_room((uint32_t)r->body, req->body, len);
    if (req->body_len > UINT32_MAX || room == WIRE_NONE) {
      amgi_send_message(&a, res, 400, S("the body is not a whole message of its kind"));
      ar_free(&a);
      return;
    }
    void *out = ar_alloc(&a, wire_schema_of((uint32_t)r->body)->size);
    wire_decode((uint32_t)r->body, req->body, len, out, ar_alloc(&a, room + 8));
    q.body = out;
  }
  amgi_read_settings(&a, req, &q.s);
  r->fn(&q);
  ar_free(&a);
}

/* The parameters of `shape` in `path` (after /api/anki/), raw, or 0 when it does not fit. */
static int shape_params(const char *shape, str *segs, size_t nsegs, str *params, int *fixed) {
  size_t i = 0, np = 0;
  *fixed = 0;
  const char *s = shape;
  while (*s) {
    const char *e = strchr(s, '/');
    size_t n = e ? (size_t)(e - s) : strlen(s);
    if (i >= nsegs) return 0;
    if (s[0] == ':') params[np++] = segs[i];
    else if (segs[i].n != n || memcmp(segs[i].p, s, n)) return 0;
    else ++*fixed;
    i++;
    s += n + (e ? 1 : 0);
    if (!e) break;
  }
  return i == nsegs;
}

/* "* /api/anki/...": serve.mjs's own matching, for every path cbase's patterns did not take. */
static void h_api_fallback(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  str path = str_c(req->path);
  str rest = str_sub(path, strlen("/api/anki/"), path.n);
  str segs[64];
  size_t nsegs = 0;
  for (size_t at = 0; at <= rest.n && nsegs < 64;) {
    size_t e = at;
    while (e < rest.n && rest.p[e] != '/') e++;
    if (e > at) segs[nsegs++] = str_sub(rest, at, e);
    at = e + 1;
  }
  /* Fixed segments before parameters, so notes/bulk wins over notes/[id]. */
  const char *best = NULL;
  int best_fixed = -1;
  str params[8], best_params[8];
  for (size_t i = 0; i < NROUTES; i++) {
    int fixed;
    if (shape_params(ROUTES[i].shape, segs, nsegs, params, &fixed) && fixed > best_fixed) {
      best = ROUTES[i].shape;
      best_fixed = fixed;
      memcpy(best_params, params, sizeof params);
    }
  }
  if (!best) {
    amgi_send_text(res, 404, S("no such route"));
    ar_free(&a);
    return;
  }
  for (size_t i = 0; i < NROUTES; i++)
    if (!strcmp(ROUTES[i].shape, best) && !strcmp(ROUTES[i].method, req->method)) {
      ar_free(&a);
      run(ctx, &ROUTES[i], best_params, req, res);
      return;
    }
  amgi_send_text(res, 501, str_c(ar_fmt(&a, "no wire layout for %s %s", req->method, req->path)));
  ar_free(&a);
}

/* One cbase handler per route, which reads the route's parameters as the router bound them. */
static void dispatch(cb_ctx *ctx, size_t i, const cb_http_req *req, cb_http_res *res) {
  str params[8];
  size_t np = 0;
  for (const char *s = ROUTES[i].shape; *s;) {
    const char *e = strchr(s, '/');
    size_t n = e ? (size_t)(e - s) : strlen(s);
    if (s[0] == ':') {
      char name[32];
      snprintf(name, sizeof name, "%.*s", (int)(n - 1), s + 1);
      params[np++] = amgi_param(req, name);
    }
    if (!e) break;
    s = e + 1;
  }
  run(ctx, &ROUTES[i], params, req, res);
}
#define THUNK(i) \
  static void h##i(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) { dispatch(ctx, i, req, res); }
THUNK(0) THUNK(1) THUNK(2) THUNK(3) THUNK(4) THUNK(5) THUNK(6) THUNK(7) THUNK(8) THUNK(9) THUNK(10)
THUNK(11) THUNK(12) THUNK(13) THUNK(14) THUNK(15) THUNK(16) THUNK(17) THUNK(18) THUNK(19) THUNK(20)
_Static_assert(NROUTES == 21, "one cbase handler per route");

/* ---- the page and its files ---- */
static void h_root(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  (void)ctx, (void)req;
  cb_res_status(res, 307);
  cb_res_header(res, "Location", "/decks");
}
static void h_page(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  serve_file(&a, ctx, req, res, S("ui/out/index.html"), "text/html; charset=utf-8");
  ar_free(&a);
}
static void h_wasm(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  serve_file(&a, ctx, req, res, S("ui/out/app.wasm"), "application/wasm");
  ar_free(&a);
}
static void h_css(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  serve_file(&a, ctx, req, res, S("ui/out/app.css"), "text/css; charset=utf-8");
  ar_free(&a);
}
/* Everything else: an icon from public/ at the top level by name (.png, .svg, .ico), or 404. */
static void h_other(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  arena a = {0};
  str path = str_c(req->path);
  const char *slash = strrchr(req->path, '/');
  str base = str_c(slash ? slash + 1 : req->path);
  str ext = path_extname(base);
  const char *type = str_eq_c(ext, ".png") ? "image/png" : str_eq_c(ext, ".svg") ? "image/svg+xml"
                     : str_eq_c(ext, ".ico") ? "image/x-icon" : NULL;
  if (type && slash == req->path && path.n > 1) serve_file(&a, ctx, req, res, str_cat(&a, S("public/"), base), type);
  else amgi_send_text(res, 404, S("not found"));
  ar_free(&a);
}

/* POST /notes/bulk takes a whole paste in one body; every other route the server's default. The two
 * Gemini routes run on cbase's slow pool (CB_ROUTE_SLOW): a card holds its thread for as long as
 * Gemini takes, and the status poll, the clips and the deck list never wait behind one. */
#define BULK_MAX_BODY ((size_t)256 << 20)
#define ANY(p, f) {.method = "*", .pattern = (p), .flags = CB_ROUTE_POOL, .fn = (f)}
static const cb_route AMGI_ROUTES[] = {
  {.method = "GET", .pattern = "/api/anki/status", .flags = CB_ROUTE_POOL, .fn = h0},
  {.method = "GET", .pattern = "/api/anki/decks", .flags = CB_ROUTE_POOL, .fn = h1},
  {.method = "POST", .pattern = "/api/anki/decks", .flags = CB_ROUTE_POOL, .fn = h2},
  {.method = "PATCH", .pattern = "/api/anki/decks/:id", .flags = CB_ROUTE_POOL, .fn = h3},
  {.method = "GET", .pattern = "/api/anki/decks/:id", .flags = CB_ROUTE_POOL, .fn = h4},
  {.method = "DELETE", .pattern = "/api/anki/decks/:id", .flags = CB_ROUTE_POOL, .fn = h5},
  {.method = "GET", .pattern = "/api/anki/decks/:id/notes", .flags = CB_ROUTE_POOL, .fn = h6},
  {.method = "GET", .pattern = "/api/anki/decks/:id/notes/field-values", .flags = CB_ROUTE_POOL, .fn = h7},
  {.method = "GET", .pattern = "/api/anki/install", .flags = CB_ROUTE_POOL, .fn = h8},
  {.method = "POST", .pattern = "/api/anki/install", .flags = CB_ROUTE_POOL, .fn = h9},
  {.method = "GET", .pattern = "/api/anki/profiles", .flags = CB_ROUTE_POOL, .fn = h10},
  {.method = "GET", .pattern = "/api/anki/notetypes", .flags = CB_ROUTE_POOL, .fn = h11},
  {.method = "POST", .pattern = "/api/anki/notes", .flags = CB_ROUTE_POOL, .fn = h12},
  {.method = "POST", .pattern = "/api/anki/notes/bulk", .flags = CB_ROUTE_POOL, .fn = h13, .max_body = BULK_MAX_BODY},
  {.method = "PATCH", .pattern = "/api/anki/notes/:id", .flags = CB_ROUTE_POOL, .fn = h14},
  {.method = "DELETE", .pattern = "/api/anki/notes/:id", .flags = CB_ROUTE_POOL, .fn = h15},
  {.method = "POST", .pattern = "/api/anki/card-text", .flags = CB_ROUTE_SLOW, .fn = h16},
  {.method = "POST", .pattern = "/api/anki/audio", .flags = CB_ROUTE_SLOW, .fn = h17},
  {.method = "GET", .pattern = "/api/anki/starter", .flags = CB_ROUTE_POOL, .fn = h18},
  {.method = "POST", .pattern = "/api/anki/starter", .flags = CB_ROUTE_POOL, .fn = h19},
  {.method = "GET", .pattern = "/api/anki/media/:filename", .flags = CB_ROUTE_POOL, .fn = h20},
  ANY("/api/anki/*", h_api_fallback),
  ANY("/", h_root),
  ANY("/decks", h_page),
  ANY("/settings", h_page),
  ANY("/deck/:id", h_page),
  ANY("/app.wasm", h_wasm),
  ANY("/app.css", h_css),
  ANY("/*", h_other),
};
const cb_route_list AMGI_ROUTE_LIST = {AMGI_ROUTES, (int)(sizeof AMGI_ROUTES / sizeof *AMGI_ROUTES)};

/* cb_app.slow_full: a Gemini request that finds every slow worker busy is refused at once, as work
 * that has not started (the bulk screen waits retryAfterMs and sends it again). Runs on serve's loop
 * thread: it builds its answer and takes no lock. */
void amgi_slow_full(cb_ctx *ctx, const cb_http_req *req, cb_http_res *res) {
  (void)ctx, (void)req;
  arena a = {0};
  amgi_error e = {0};
  e.error = S("amgi is making as many cards as it can at once; this one waits 2s before starting.");
  e.has_retry = 1;
  e.retry_after_ms = 2000;
  e.not_started = 1;
  amgi_send_error(&a, res, 429, &e);
  ar_free(&a);
}
