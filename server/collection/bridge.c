/* src/server/anki/bridgeClient.js in C: see bridge.h. The HTTP is cbase's blocking client
 * (cb_http_plain_request, and cb_https_request for an https:// bridge), one request per call. */
#include "bridge.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include "core.h"
#include "net/https.h"
#include "util/err.h"
#include "wire.h"

#define DEFAULT_TIMEOUT_MS 1500
#define OPERATION_TIMEOUT_MS 30000
#define PROTOCOL_HEADER "X-Amgi-Bridge-Protocol"

/* ---- the request ---- */
typedef struct {
  const col_bridge *b;
  const char *method;
  str path;
  uint32_t answer;            /* the kind of a 2xx answer */
  int has_send;
  uint32_t send_kind;
  const void *send;           /* the request kind's struct */
  int timeout_ms;
  void *out;                  /* the answer kind's struct */
  int outdated;               /* set when the add-on speaks another protocol */
} call;

static str js_number(cx *c, double v) {
  buf b = {0};
  js_num(&b, v);
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* encodeURIComponent: every byte but A-Z a-z 0-9 - _ . ! ~ * ' ( ) escaped. */
static str uri_component(cx *c, str s) {
  buf b = {0};
  for (size_t i = 0; i < s.n; i++) {
    unsigned char ch = (unsigned char)s.p[i];
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || strchr("-_.!~*'()", ch))
      buf_ch(&b, (char)ch);
    else
      buf_fmt(&b, "%%%02X", ch);
  }
  str out = buf_str(c->a, &b);
  buf_free(&b);
  return out;
}

/* `${baseUrl.replace(/\/$/, '')}${path}` as fetch reads it: http or https, a host, a port (80 and
 * 443 by default), and a path prefix. 0, or -1 when it is not a URL fetch would take. */
static int split_url(cx *c, str url, str path, int *tls, const char **host, int *port, const char **full_path) {
  str u = url;
  if (u.n && u.p[u.n - 1] == '/') u.n--;
  if (str_starts(u, S("http://"))) *tls = 0, u = str_sub(u, 7, u.n);
  else if (str_starts(u, S("https://"))) *tls = 1, u = str_sub(u, 8, u.n);
  else return -1;
  size_t slash = 0;
  while (slash < u.n && u.p[slash] != '/') slash++;
  str hostport = str_sub(u, 0, slash), prefix = str_sub(u, slash, u.n);
  if (!hostport.n) return -1;
  size_t colon = hostport.n;
  while (colon > 0 && hostport.p[colon - 1] != ':') colon--;
  *port = *tls ? 443 : 80;
  str h = hostport;
  if (colon > 0) {
    int ok;
    int64_t p = js_int(str_sub(hostport, colon, hostport.n), &ok);
    if (!ok || p <= 0 || p > 65535) return -1;
    *port = (int)p;
    h = str_sub(hostport, 0, colon - 1);
  }
  *host = str_z(c->a, h);
  *full_path = str_z(c->a, str_cat(c->a, prefix, path));
  return 0;
}

/* A response header's value, as Headers.get answers it (the first, trimmed), or "". */
static str header_value(cx *c, const cb_buf *head, const char *name) {
  str h = {(const char *)head->p, head->len};
  size_t nn = strlen(name);
  for (size_t i = 0; i < h.n;) {
    size_t end = i;
    while (end < h.n && h.p[end] != '\n') end++;
    str line = str_sub(h, i, end);
    if (line.n && line.p[line.n - 1] == '\r') line.n--;
    if (line.n > nn && line.p[nn] == ':' && !strncasecmp(line.p, name, nn))
      return js_trim(str_c(ar_dup(c->a, line.p + nn + 1, line.n - nn - 1)));
    i = end + 1;
  }
  return S("");
}

static int64_t mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

uint8_t *wire_host_grow(uint8_t *p, uint32_t len, uint32_t cap);

/* Decode bytes of kind into out, or 0 when they are not one whole message of it. Strings point
 * into the arena's copy of the bytes. */
static int decode(cx *c, uint32_t kind, const cb_buf *body, void *out) {
  uint8_t *p = (uint8_t *)ar_dup(c->a, body->p ? (const char *)body->p : "", body->len);
  uint32_t room = wire_room(kind, p, (uint32_t)body->len);
  if (room == WIRE_NONE) return 0;
  void *mem = ar_alloc(c->a, room ? room : 8);
  wire_decode(kind, p, (uint32_t)body->len, out, mem);
  return 1;
}

static void throw_status(cx *c, int status, str message) { cx_throw(c, NULL, status, "%.*s", (int)message.n, message.p); }

/* bridgeFetch. */
static void fetch(cx *c, call *k) {
  int tls, port;
  const char *host, *path;
  if (split_url(c, k->b->url, k->path, &tls, &host, &port, &path) < 0) cx_throw(c, NULL, 0, "fetch failed");
  buf headers = {0};
  buf_fmt(&headers, "X-Amgi-Bridge-Token: %.*s\r\n%s: %u\r\n", (int)k->b->token.n, k->b->token.p, PROTOCOL_HEADER,
          (unsigned)WIRE_BRIDGE_PROTOCOL);
  wire_buf body = {0};
  if (k->has_send) {
    buf_c(&headers, "Content-Type: " WIRE_MIME "\r\n");
    wire_encode(&body, k->send_kind, k->send);
  }
  cb_https_response r = {0};
  int64_t started = mono_ms();
  int rc = (tls ? cb_https_request : cb_http_plain_request)(host, port, k->method, path, headers.p, body.p, body.len,
                                                            k->timeout_ms, &r);
  int64_t took = mono_ms() - started;
  buf_free(&headers);
  free(body.p);
  if (rc != CB_OK) {
    cb_https_response_free(&r);
    /* fetch's two failures: the AbortController's timer fired, or there was no answer at all. */
    cx_throw(c, NULL, 0, took >= k->timeout_ms ? "This operation was aborted" : "fetch failed");
  }
  int status = r.status;
  str theirs = header_value(c, &r.headers, PROTOCOL_HEADER);
  char ours[16];
  snprintf(ours, sizeof ours, "%u", (unsigned)WIRE_BRIDGE_PROTOCOL);
  cb_buf rbody = r.body;
  /* The arena keeps what the answer needs; the response goes now. */
  cb_buf kept = {(uint8_t *)ar_dup(c->a, rbody.p ? (const char *)rbody.p : "", rbody.len), rbody.len, rbody.len, false};
  cb_https_response_free(&r);
  int ok = status >= 200 && status < 300;
  if (!str_eq_c(theirs, ours)) {
    /* A refusal of the token or the origin from an add-on too old to name its protocol says nothing
     * about its version: only an answer (or the new add-on's own 409) does. */
    if (ok || status == 409) {
      k->outdated = 1;
      cx_throw(c, NULL, 409, "the amgi add-on in Anki speaks bridge protocol %.*s, this amgi %u",
               theirs.n ? (int)theirs.n : (int)strlen("none (it predates them)"), theirs.n ? theirs.p : "none (it predates them)",
               (unsigned)WIRE_BRIDGE_PROTOCOL);
    }
    cx_throw(c, NULL, status, "bridge responded %d", status);
  }
  if (!ok) {
    wire_b_error e;
    str msg = {0};
    if (decode(c, WK_B_ERROR, &kept, &e) && e.error.len) msg = utf8_clean(c->a, (str){e.error.p, e.error.len});
    if (msg.n) throw_status(c, status, msg);
    cx_throw(c, NULL, status, "bridge responded %d", status);
  }
  if (!decode(c, k->answer, &kept, k->out)) cx_throw(c, NULL, 502, "the bridge's answer is not a whole %s message", wire_kind_name(k->answer));
}

static str ws(cx *c, wire_str s) { return utf8_clean(c->a, (str){s.p ? s.p : "", s.len}); }
static wire_str to_ws(str s) { return (wire_str){s.p ? s.p : "", (uint32_t)s.n}; }
static wire_strs to_wss(cx *c, const str *v, size_t n) {
  wire_str *out = ar_alloc(c->a, (n + 1) * sizeof *out);
  for (size_t i = 0; i < n; i++) out[i] = to_ws(v[i]);
  return (wire_strs){out, (uint32_t)n};
}
static str *from_wss(cx *c, wire_strs v, size_t *n) {
  str *out = ar_alloc(c->a, (v.n + 1) * sizeof *out);
  for (uint32_t i = 0; i < v.n; i++) out[i] = ws(c, v.v[i]);
  *n = v.n;
  return out;
}

/* Run one call under a cx, catching what it throws into *err. */
typedef struct { void (*fn)(cx *, void *); void *arg; } run_args;
static int run(arena *a, void (*fn)(cx *, void *), void *arg, col_err *err) {
  cx c = {a, NULL, {0}};
  if (cx_try(&c, fn, arg) < 0) {
    if (err) *err = c.err;
    return -1;
  }
  return 0;
}

/* ---- the ops ---- */
typedef struct { const col_bridge *b; col_bridge_status *status; int result; col_err outdated; } probe_args;
static void bridge_status_of(cx *c, const wire_b_status *s, col_bridge_status *out) {
  out->profile_open = s->profile_open;
  out->profile_name = ws(c, s->profile_name);
  out->collection_open = s->collection_open;
  out->has_schema = s->schema_version != WIRE_NONE;
  out->schema = s->schema_version;
  out->anki_version = ws(c, s->anki_version);
  out->qt_version = ws(c, s->qt_version);
}
static void probe_body(cx *c, void *arg) {
  probe_args *p = arg;
  wire_b_status s;
  call k = {p->b, "GET", S("/status"), WK_B_STATUS, 0, 0, NULL, DEFAULT_TIMEOUT_MS, &s, 0};
  cx inner = {c->a, NULL, {0}};
  typedef struct { call *k; } fa;
  (void)inner;
  jmp_buf jb, *outer = c->jb;
  c->jb = &jb;
  if (setjmp(jb)) {
    c->jb = outer;
    if (k.outdated) {
      p->result = BRIDGE_OUTDATED;
      p->outdated = c->err;
    } else {
      p->result = BRIDGE_NONE;
    }
    return;
  }
  fetch(c, &k);
  c->jb = outer;
  bridge_status_of(c, &s, p->status);
  p->result = BRIDGE_ANSWERED;
}
int col_bridge_probe(arena *a, const col_bridge *b, col_bridge_status *status, col_err *outdated) {
  probe_args p = {b, status, BRIDGE_NONE, {0}};
  if (run(a, probe_body, &p, NULL) < 0) return BRIDGE_NONE;
  if (p.result == BRIDGE_OUTDATED && outdated) *outdated = p.outdated;
  return p.result;
}

typedef struct { const col_bridge *b; col_deck **out; size_t *n; } decks_args;
static void decks_body(cx *c, void *arg) {
  decks_args *d = arg;
  wire_b_decks r;
  call k = {d->b, "GET", S("/decks"), WK_B_DECKS, 0, 0, NULL, DEFAULT_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->out = ar_alloc(c->a, (r.ndecks + 1) * sizeof **d->out);
  for (uint32_t i = 0; i < r.ndecks; i++) (*d->out)[i] = (col_deck){r.decks[i].id, ws(c, r.decks[i].name)};
  *d->n = r.ndecks;
}
int col_bridge_list_decks(arena *a, const col_bridge *b, col_deck **out, size_t *n, col_err *err) {
  decks_args d = {b, out, n};
  *n = 0;
  return run(a, decks_body, &d, err);
}

typedef struct { const col_bridge *b; col_notetype **out; size_t *n; } nts_args;
static void nts_body(cx *c, void *arg) {
  nts_args *d = arg;
  wire_b_notetypes r;
  call k = {d->b, "GET", S("/notetypes"), WK_B_NOTETYPES, 0, 0, NULL, DEFAULT_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  col_notetype *out = ar_alloc(c->a, (r.nnotetypes + 1) * sizeof *out);
  for (uint32_t i = 0; i < r.nnotetypes; i++) {
    const wire_b_notetype *w = &r.notetypes[i];
    out[i].id = w->id;
    out[i].name = ws(c, w->name);
    out[i].cloze = str_eq_c(ws(c, w->kind), "cloze");
    out[i].sort_field = w->sort_field_index;
    out[i].fields = from_wss(c, w->field_names, &out[i].nfields);
    out[i].templates = ar_alloc(c->a, (w->ntemplates + 1) * sizeof *out[i].templates);
    for (uint32_t t = 0; t < w->ntemplates; t++)
      out[i].templates[t] = (col_template){w->templates[t].ord, ws(c, w->templates[t].name), ws(c, w->templates[t].question_format),
                                           ws(c, w->templates[t].answer_format)};
    out[i].ntemplates = w->ntemplates;
  }
  *d->out = out;
  *d->n = r.nnotetypes;
}
int col_bridge_list_notetypes(arena *a, const col_bridge *b, col_notetype **out, size_t *n, col_err *err) {
  nts_args d = {b, out, n};
  *n = 0;
  return run(a, nts_body, &d, err);
}

typedef struct { const col_bridge *b; double deck, offset, limit; col_page *out; int64_t *total; } notes_args;
static void notes_body(cx *c, void *arg) {
  notes_args *d = arg;
  wire_b_notes r;
  str did = js_number(c, d->deck), off = js_number(c, d->offset), lim = js_number(c, d->limit);
  str path = str_c(ar_fmt(c->a, "/decks/%.*s/notes?offset=%.*s&limit=%.*s", (int)did.n, did.p, (int)off.n, off.p, (int)lim.n, lim.p));
  call k = {d->b, "GET", path, WK_B_NOTES, 0, 0, NULL, DEFAULT_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  col_note *notes = ar_alloc(c->a, (r.nnotes + 1) * sizeof *notes);
  for (uint32_t i = 0; i < r.nnotes; i++) {
    notes[i].id = r.notes[i].id;
    notes[i].notetype_id = r.notes[i].notetype_id;
    notes[i].fields = from_wss(c, r.notes[i].fields, &notes[i].nfields);
    notes[i].tags = from_wss(c, r.notes[i].tags, &notes[i].ntags);
  }
  d->out->notes = notes;
  d->out->n = r.nnotes;
  d->out->offset = r.offset;
  d->out->limit = r.limit;
  /* withNormalizedPaging */
  d->out->has_more = (double)r.offset + r.nnotes < (double)r.total;
  if (d->total) *d->total = r.total;
}
int col_bridge_list_notes(arena *a, const col_bridge *b, double deck, double offset, double limit, col_page *out,
                          int64_t *total, col_err *err) {
  memset(out, 0, sizeof *out);
  notes_args d = {b, deck, offset, limit, out, total};
  return run(a, notes_body, &d, err);
}
int col_bridge_count_notes(arena *a, const col_bridge *b, double deck, int64_t *out, col_err *err) {
  col_page p;
  return col_bridge_list_notes(a, b, deck, 0, 1, &p, out, err);
}

typedef struct { const col_bridge *b; double deck, nt, field; str **out; size_t *n; } values_args;
static void values_body(cx *c, void *arg) {
  values_args *d = arg;
  wire_b_values r;
  str did = js_number(c, d->deck), nt = js_number(c, d->nt), fi = js_number(c, d->field);
  str path = str_c(ar_fmt(c->a, "/decks/%.*s/notes/field-values?notetypeId=%.*s&fieldIndex=%.*s", (int)did.n, did.p, (int)nt.n,
                          nt.p, (int)fi.n, fi.p));
  call k = {d->b, "GET", path, WK_B_VALUES, 0, 0, NULL, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->out = from_wss(c, r.values, d->n);
}
int col_bridge_field_values(arena *a, const col_bridge *b, double deck, double notetype, double field, str **out, size_t *n,
                            col_err *err) {
  values_args d = {b, deck, notetype, field, out, n};
  *n = 0;
  return run(a, values_body, &d, err);
}

typedef struct { const col_bridge *b; str name; col_deck_made *out; } create_args;
static void create_body(cx *c, void *arg) {
  create_args *d = arg;
  wire_q_deck_name q = {to_ws(d->name)};
  wire_b_deck_created r;
  call k = {d->b, "POST", S("/decks"), WK_B_DECK_CREATED, 1, WK_Q_DECK_NAME, &q, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->out = (col_deck_made){r.id, ws(c, r.name), r.created};
}
int col_bridge_create_deck(arena *a, const col_bridge *b, str name, col_deck_made *out, col_err *err) {
  create_args d = {b, name, out};
  return run(a, create_body, &d, err);
}

/* A note as q_note: language "" when absent, the learning field index absent as WIRE_ABSENT. */
static wire_q_note q_note_of(cx *c, const col_new_note *n) {
  wire_q_note q = {0};
  q.deck_id = (int64_t)n->deck_id;
  q.notetype_id = (int64_t)n->notetype_id;
  q.fields = to_wss(c, n->fields, n->nfields);
  q.tags = to_wss(c, n->tags, n->ntags);
  q.language = to_ws(n->has_language ? n->language : S(""));
  q.learning_field_index = n->has_learning_field && isfinite(n->learning_field) ? (int32_t)n->learning_field : WIRE_ABSENT;
  return q;
}

typedef struct { const col_bridge *b; const col_new_note *notes; size_t n; col_added *out; size_t *nout; } add_args;
static void add_one_body(cx *c, void *arg) {
  add_args *d = arg;
  wire_q_note q = q_note_of(c, d->notes);
  wire_b_note r;
  call k = {d->b, "POST", S("/notes"), WK_B_NOTE, 1, WK_Q_NOTE, &q, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  memset(d->out, 0, sizeof *d->out);
  d->out->ok = 1;
  d->out->note_id = r.note_id;
  /* withoutEmptyWarning: "" on the wire is no warning. */
  d->out->has_warning = r.warning.len > 0;
  d->out->warning = ws(c, r.warning);
}
int col_bridge_add_note(arena *a, const col_bridge *b, const col_new_note *note, col_added *out, col_err *err) {
  add_args d = {b, note, 1, out, NULL};
  return run(a, add_one_body, &d, err);
}
static void add_bulk_body(cx *c, void *arg) {
  add_args *d = arg;
  wire_q_notes q = {ar_alloc(c->a, (d->n + 1) * sizeof(wire_q_note)), (uint32_t)d->n};
  for (size_t i = 0; i < d->n; i++) q.notes[i] = q_note_of(c, &d->notes[i]);
  wire_b_notes_added r;
  call k = {d->b, "POST", S("/notes/bulk"), WK_B_NOTES_ADDED, 1, WK_Q_NOTES, &q, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  for (uint32_t i = 0; i < r.nresults && i < d->n; i++) {
    memset(&d->out[i], 0, sizeof d->out[i]);
    d->out[i].ok = r.results[i].ok;
    d->out[i].note_id = r.results[i].note_id;
    d->out[i].error = ws(c, r.results[i].error);
  }
  *d->nout = r.nresults < d->n ? r.nresults : d->n;
}
int col_bridge_add_notes(arena *a, const col_bridge *b, const col_new_note *notes, size_t n, col_added *out, size_t *nout,
                         col_err *err) {
  add_args d = {b, notes, n, out, nout};
  *nout = 0;
  return run(a, add_bulk_body, &d, err);
}

typedef struct {
  const col_bridge *b;
  double note;
  const str *fields;
  size_t nfields;
  int has_language;
  str language;
  int has_lfi;
  double lfi;
  int64_t *note_id;
  int *has_warning;
  str *warning;
} update_args;
static void update_body(cx *c, void *arg) {
  update_args *d = arg;
  wire_q_note_update q = {to_wss(c, d->fields, d->nfields), to_ws(d->has_language ? d->language : S("")),
                          d->has_lfi && isfinite(d->lfi) ? (int32_t)d->lfi : WIRE_ABSENT};
  str id = js_number(c, d->note);
  wire_b_note r;
  call k = {d->b, "PATCH", str_c(ar_fmt(c->a, "/notes/%.*s", (int)id.n, id.p)), WK_B_NOTE, 1, WK_Q_NOTE_UPDATE, &q,
            OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->note_id = r.note_id;
  *d->has_warning = r.warning.len > 0;
  *d->warning = ws(c, r.warning);
}
int col_bridge_update_note(arena *a, const col_bridge *b, double note, const str *fields, size_t nfields, int has_language,
                           str language, int has_learning_field, double learning_field, int64_t *note_id, int *has_warning,
                           str *warning, col_err *err) {
  update_args d = {b, note, fields, nfields, has_language, language, has_learning_field, learning_field, note_id, has_warning, warning};
  *has_warning = 0;
  return run(a, update_body, &d, err);
}

typedef struct { const col_bridge *b; str name; int *exists; int *found; str *bytes; const void *data; size_t len; str *stored; } media_args;
static void has_media_body(cx *c, void *arg) {
  media_args *d = arg;
  str name = uri_component(c, d->name);
  wire_b_media_exists r;
  call k = {d->b, "GET", str_c(ar_fmt(c->a, "/media/%.*s", (int)name.n, name.p)), WK_B_MEDIA_EXISTS, 0, 0, NULL, DEFAULT_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->exists = r.exists;
}
int col_bridge_has_media(arena *a, const col_bridge *b, str name, int *out, col_err *err) {
  media_args d = {b, name, out, NULL, NULL, NULL, 0, NULL};
  return run(a, has_media_body, &d, err);
}
static void read_media_body(cx *c, void *arg) {
  media_args *d = arg;
  str name = uri_component(c, d->name);
  wire_b_media_data r;
  call k = {d->b, "GET", str_c(ar_fmt(c->a, "/media/%.*s/data", (int)name.n, name.p)), WK_B_MEDIA_DATA, 0, 0, NULL,
            DEFAULT_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->found = r.found;
  *d->bytes = (str){r.data.p ? r.data.p : "", r.data.len};
}
int col_bridge_read_media(arena *a, const col_bridge *b, str name, int *found, str *bytes, col_err *err) {
  media_args d = {b, name, NULL, found, bytes, NULL, 0, NULL};
  *found = 0;
  return run(a, read_media_body, &d, err);
}
static void add_media_body(cx *c, void *arg) {
  media_args *d = arg;
  wire_b_q_media q = {to_ws(d->name), {d->data ? d->data : "", (uint32_t)d->len}};
  wire_b_media_added r;
  call k = {d->b, "POST", S("/media"), WK_B_MEDIA_ADDED, 1, WK_B_Q_MEDIA, &q, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->stored = ws(c, r.filename);
}
int col_bridge_add_media(arena *a, const col_bridge *b, str name, const void *data, size_t len, str *stored, col_err *err) {
  media_args d = {b, name, NULL, NULL, NULL, data, len, stored};
  return run(a, add_media_body, &d, err);
}

typedef struct { const col_bridge *b; double deck; str name; col_deck *renamed; col_removal *removal; int64_t *nid, *removed; } deck_args;
static void rename_body(cx *c, void *arg) {
  deck_args *d = arg;
  wire_q_deck_name q = {to_ws(d->name)};
  str id = js_number(c, d->deck);
  wire_b_deck r;
  call k = {d->b, "PATCH", str_c(ar_fmt(c->a, "/decks/%.*s", (int)id.n, id.p)), WK_B_DECK, 1, WK_Q_DECK_NAME, &q,
            OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->renamed = (col_deck){r.id, ws(c, r.name)};
}
int col_bridge_rename_deck(arena *a, const col_bridge *b, double deck, str name, col_deck *out, col_err *err) {
  deck_args d = {b, deck, name, out, NULL, NULL, NULL};
  return run(a, rename_body, &d, err);
}
static void summary_body(cx *c, void *arg) {
  deck_args *d = arg;
  str id = js_number(c, d->deck);
  wire_b_deck_summary r;
  call k = {d->b, "GET", str_c(ar_fmt(c->a, "/decks/%.*s", (int)id.n, id.p)), WK_B_DECK_SUMMARY, 0, 0, NULL, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->removal = (col_removal){r.id, ws(c, r.name), r.subdecks, 0, r.cards, r.notes};
}
int col_bridge_removal_summary(arena *a, const col_bridge *b, double deck, col_removal *out, col_err *err) {
  deck_args d = {b, deck, {0}, NULL, out, NULL, NULL};
  return run(a, summary_body, &d, err);
}
static void remove_deck_body(cx *c, void *arg) {
  deck_args *d = arg;
  str id = js_number(c, d->deck);
  wire_b_deck_removed r;
  call k = {d->b, "DELETE", str_c(ar_fmt(c->a, "/decks/%.*s", (int)id.n, id.p)), WK_B_DECK_REMOVED, 0, 0, NULL, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->removal = (col_removal){r.id, ws(c, r.name), 0, r.decks, r.cards, r.notes};
}
int col_bridge_remove_deck(arena *a, const col_bridge *b, double deck, col_removal *out, col_err *err) {
  deck_args d = {b, deck, {0}, NULL, out, NULL, NULL};
  return run(a, remove_deck_body, &d, err);
}
static void remove_note_body(cx *c, void *arg) {
  deck_args *d = arg;
  str id = js_number(c, d->deck);
  wire_b_note_removed r;
  call k = {d->b, "DELETE", str_c(ar_fmt(c->a, "/notes/%.*s", (int)id.n, id.p)), WK_B_NOTE_REMOVED, 0, 0, NULL, OPERATION_TIMEOUT_MS, &r, 0};
  fetch(c, &k);
  *d->nid = r.note_id;
  *d->removed = r.cards_removed;
}
int col_bridge_remove_note(arena *a, const col_bridge *b, double note, int64_t *note_id, int64_t *cards_removed, col_err *err) {
  deck_args d = {b, note, {0}, NULL, NULL, note_id, cards_removed};
  return run(a, remove_note_body, &d, err);
}
