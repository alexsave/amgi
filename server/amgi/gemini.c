/* gemini.ts, geminiWire.ts and geminiSpeech.ts in C (gemini.h). */
#include "gemini.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include "../collection/rng.h"
#include "messages.h"
#include "net/grpc.h"
#include "util/err.h"

#define GEMINI_API_BASE "https://generativelanguage.googleapis.com"
#define GENERATE_CONTENT_PATH "/google.ai.generativelanguage.v1beta.GenerativeService/GenerateContent"
#define MAX_RATE_LIMIT_WAIT_MS 30000
#define REQUEST_TIMEOUT_MS 60000
#define RESOURCE_EXHAUSTED 8
#define TYPE_URL_PREFIX "type.googleapis.com/google.rpc."

static const char *const VOICES[] = {
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
  "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib",
  "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
  "Achird", "Zubenelgenubi"};
#define NVOICES (sizeof VOICES / sizeof *VOICES)
#define TTS_MODEL "gemini-3.8-flash-tts"

void gem_fail(arena *a, gem_err *e, int kind, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  char tmp[2048];
  vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  e->kind = kind;
  e->message = str_c(ar_dup(a, tmp, strlen(tmp)));
  e->retry_after_ms = 0;
}

/* ---- protobuf writing (protobuf.js's writers) ---- */
static void pw_varint(buf *b, uint64_t v) {
  while (v >= 0x80) {
    buf_ch(b, (char)(v | 0x80));
    v >>= 7;
  }
  buf_ch(b, (char)v);
}
static void pw_tag(buf *b, uint32_t field, uint32_t wire) { pw_varint(b, (uint64_t)field << 3 | wire); }
static void pw_bytes(buf *b, uint32_t field, const void *p, size_t n) {
  pw_tag(b, field, 2);
  pw_varint(b, n);
  buf_put(b, p, n);
}
static void pw_str(buf *b, uint32_t field, const char *s) { pw_bytes(b, field, s, strlen(s)); }
static void pw_msg(buf *b, uint32_t field, const buf *m) { pw_bytes(b, field, m->p, m->n); }
static void pw_vfield(buf *b, uint32_t field, uint64_t v) {
  pw_tag(b, field, 0);
  pw_varint(b, v);
}

/* ---- google.protobuf.Value (geminiWire.ts encodeValue) ---- */
void gv_string(buf *b, const char *s) { pw_str(b, 3, s); }
void gv_bool(buf *b, int v) { pw_vfield(b, 4, v ? 1 : 0); }
void gv_field(buf *body, const char *key, const buf *value) {
  buf entry = {0};
  pw_str(&entry, 1, key);
  pw_msg(&entry, 2, value);
  pw_msg(body, 1, &entry);
  buf_free(&entry);
}
void gv_struct_of(buf *b, const buf *body) { pw_msg(b, 5, body); }
void gv_list_item(buf *items, const buf *value) { pw_msg(items, 1, value); }
void gv_list_of(buf *b, const buf *items) { pw_msg(b, 6, items); }

/* GenerateContentRequest, its fields in number order as geminiWire.ts's encode writes them. */
void gem_encode(buf *out, const char *model, const gem_request *r) {
  char name[128];
  snprintf(name, sizeof name, "models/%s", model);
  pw_str(out, 1, name);
  buf content = {0};
  for (int i = 0; i < r->nparts; i++) {
    buf part = {0};
    if (r->parts[i].text.p) pw_bytes(&part, 2, r->parts[i].text.p, r->parts[i].text.n);
    if (r->parts[i].audio) {
      buf blob = {0};
      pw_str(&blob, 1, "audio/wav");
      pw_bytes(&blob, 2, r->parts[i].audio, r->parts[i].audio_len);
      pw_msg(&part, 3, &blob);
      buf_free(&blob);
    }
    pw_msg(&content, 1, &part);
    buf_free(&part);
  }
  if (r->role) pw_str(&content, 2, r->role);
  pw_msg(out, 2, &content);
  buf_free(&content);
  buf config = {0};
  if (r->schema) pw_str(&config, 13, "application/json");
  if (r->voice) {
    buf packed = {0};
    pw_varint(&packed, 3); /* AUDIO */
    pw_msg(&config, 20, &packed);
    buf_free(&packed);
    buf prebuilt = {0}, voice = {0}, speech = {0};
    pw_str(&prebuilt, 1, r->voice);
    pw_msg(&voice, 1, &prebuilt);
    pw_msg(&speech, 1, &voice);
    pw_msg(&config, 21, &speech);
    buf_free(&prebuilt), buf_free(&voice), buf_free(&speech);
  }
  if (r->thinking) {
    buf thinking = {0};
    pw_vfield(&thinking, 4, 1); /* LOW */
    pw_msg(&config, 22, &thinking);
    buf_free(&thinking);
  }
  if (r->schema) pw_msg(&config, 28, r->schema);
  pw_msg(out, 4, &config); /* always sent: an empty generationConfig is still an object */
  buf_free(&config);
  if (r->system) {
    buf sys = {0}, part = {0};
    pw_str(&part, 2, r->system);
    pw_msg(&sys, 1, &part);
    pw_msg(out, 8, &sys);
    buf_free(&sys), buf_free(&part);
  }
}

/* ---- protobuf reading ---- */
typedef struct {
  uint32_t field, wire;
  uint64_t v;
  const unsigned char *p;
  size_t n;
} pf;
/* The next field: 1, 0 at the end, -1 when the bytes are not a message. */
static int pr_next(const unsigned char *p, size_t n, size_t *at, pf *f) {
  if (*at >= n) return 0;
  uint64_t key = 0;
  for (int shift = 0;; shift += 7) {
    if (*at >= n || shift > 63) return -1;
    unsigned char c = p[(*at)++];
    key |= (uint64_t)(c & 0x7f) << shift;
    if (!(c & 0x80)) break;
  }
  f->field = (uint32_t)(key >> 3), f->wire = (uint32_t)(key & 7);
  f->p = NULL, f->n = 0, f->v = 0;
  switch (f->wire) {
  case 0:
    for (int shift = 0;; shift += 7) {
      if (*at >= n || shift > 63) return -1;
      unsigned char c = p[(*at)++];
      f->v |= (uint64_t)(c & 0x7f) << shift;
      if (!(c & 0x80)) break;
    }
    return 1;
  case 1:
    if (n - *at < 8) return -1;
    f->p = p + *at, f->n = 8, *at += 8;
    return 1;
  case 5:
    if (n - *at < 4) return -1;
    f->p = p + *at, f->n = 4, *at += 4;
    return 1;
  case 2: {
    uint64_t len = 0;
    for (int shift = 0;; shift += 7) {
      if (*at >= n || shift > 63) return -1;
      unsigned char c = p[(*at)++];
      len |= (uint64_t)(c & 0x7f) << shift;
      if (!(c & 0x80)) break;
    }
    if (len > n - *at) return -1;
    f->p = p + *at, f->n = (size_t)len, *at += (size_t)len;
    return 1;
  }
  default:
    return -1;
  }
}

static const char *const FINISH_REASONS[] = {
  "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "LANGUAGE", "BLOCKLIST",
  "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"};
static const char *const BLOCK_REASONS[] = {"BLOCK_REASON_UNSPECIFIED", "SAFETY", "OTHER", "BLOCKLIST",
                                            "PROHIBITED_CONTENT", "IMAGE_SAFETY"};
static str enum_name(arena *a, const char *const *names, size_t n, uint64_t v) {
  if (v < n) return str_c(names[v]);
  return str_c(ar_fmt(a, "%llu", (unsigned long long)v));
}

/* A mismatched wire type on a known field: the bytes are not what we think. */
typedef struct { arena *a; const char *error; } rd;
#define WANT(f, w, where) \
  do { if ((f).wire != (w)) { r->error = where; return -1; } } while (0)

static int read_part(rd *r, const unsigned char *p, size_t n, gem_part_out *out) {
  size_t at = 0;
  pf f;
  int k;
  memset(out, 0, sizeof *out);
  while ((k = pr_next(p, n, &at, &f)) == 1) {
    if (f.field == 2) {
      WANT(f, 2, "Part.text: unexpected field");
      out->has_text = 1, out->text = str_c(""), out->text = (str){ar_dup(r->a, f.p, f.n), f.n};
    } else if (f.field == 11) {
      WANT(f, 0, "Part.thought: unexpected field");
      out->thought = f.v != 0;
    } else if (f.field == 3) {
      WANT(f, 2, "Part.inlineData: unexpected field");
      out->has_inline = 1, out->mime = S(""), out->data = S("");
      size_t at2 = 0;
      pf g;
      int k2;
      while ((k2 = pr_next(f.p, f.n, &at2, &g)) == 1) {
        if (g.field == 1) {
          WANT(g, 2, "Blob.mimeType: unexpected field");
          out->mime = (str){ar_dup(r->a, g.p, g.n), g.n};
        } else if (g.field == 2) {
          WANT(g, 2, "Blob.data: unexpected field");
          out->data = (str){ar_dup(r->a, g.p, g.n), g.n};
          out->has_data = 1;
        }
      }
      if (k2 < 0) return r->error = "Blob: not a message", -1;
    }
  }
  return k < 0 ? (r->error = "Part: not a message", -1) : 0;
}

/* GenerateContentResponse: the first candidate, and the prompt's block reason (or NULL). */
static int read_response(rd *r, const unsigned char *p, size_t n, gem_response *out, str *block) {
  size_t at = 0;
  pf f;
  int k, seen = 0;
  memset(out, 0, sizeof *out);
  *block = (str){0};
  while ((k = pr_next(p, n, &at, &f)) == 1) {
    if (f.field == 1) {
      WANT(f, 2, "GenerateContentResponse.candidates: unexpected field");
      if (seen++) continue; /* candidates[0] */
      size_t at2 = 0;
      pf g;
      int k2;
      while ((k2 = pr_next(f.p, f.n, &at2, &g)) == 1) {
        if (g.field == 1) {
          WANT(g, 2, "Candidate.content: unexpected field");
          /* the last content wins; its parts in order */
          size_t np = 0, cap = 4;
          gem_part_out *parts = ar_alloc(r->a, cap * sizeof *parts);
          size_t at3 = 0;
          pf h;
          int k3;
          while ((k3 = pr_next(g.p, g.n, &at3, &h)) == 1) {
            if (h.field == 1) {
              WANT(h, 2, "Content.parts: unexpected field");
              if (np == cap) {
                gem_part_out *more = ar_alloc(r->a, cap * 2 * sizeof *more);
                memcpy(more, parts, cap * sizeof *more);
                parts = more, cap *= 2;
              }
              if (read_part(r, h.p, h.n, &parts[np++])) return -1;
            } else if (h.field == 2) {
              WANT(h, 2, "Content.role: unexpected field");
            }
          }
          if (k3 < 0) return r->error = "Content: not a message", -1;
          out->parts = parts, out->nparts = np;
        } else if (g.field == 2) {
          WANT(g, 0, "Candidate.finishReason: unexpected field");
          out->finish_reason = enum_name(r->a, FINISH_REASONS, sizeof FINISH_REASONS / sizeof *FINISH_REASONS, g.v);
        }
      }
      if (k2 < 0) return r->error = "Candidate: not a message", -1;
    } else if (f.field == 2) {
      WANT(f, 2, "GenerateContentResponse.promptFeedback: unexpected field");
      size_t at2 = 0;
      pf g;
      int k2;
      *block = (str){0};
      while ((k2 = pr_next(f.p, f.n, &at2, &g)) == 1)
        if (g.field == 1) {
          WANT(g, 0, "PromptFeedback.blockReason: unexpected field");
          *block = enum_name(r->a, BLOCK_REASONS, sizeof BLOCK_REASONS / sizeof *BLOCK_REASONS, g.v);
        }
      if (k2 < 0) return r->error = "PromptFeedback: not a message", -1;
    }
  }
  return k < 0 ? (r->error = "not a message", -1) : 0;
}

str gem_response_text(arena *a, const gem_response *r) {
  buf b = {0};
  for (size_t i = 0; i < r->nparts; i++)
    if (!r->parts[i].thought && r->parts[i].has_text) buf_s(&b, r->parts[i].text);
  str out = buf_str(a, &b);
  buf_free(&b);
  return js_trim(out);
}

/* ---- google.rpc.Status details (geminiWire.ts statusDetails) ---- */
typedef struct {
  int has_daily;
  int free_tier, has_limit;
  double limit;
  int has_delay;
  int64_t delay_ms;
} details;

static int icontains(str hay, const char *needle) {
  size_t n = strlen(needle);
  for (size_t i = 0; i + n <= hay.n; i++)
    if (!strncasecmp(hay.p + i, needle, n)) return 1;
  return 0;
}

static void read_details(const unsigned char *p, size_t n, details *d) {
  memset(d, 0, sizeof *d);
  size_t at = 0;
  pf f;
  int found_daily = 0;
  while (pr_next(p, n, &at, &f) == 1) {
    if (f.field != 3 || f.wire != 2) continue;
    str type = {0}, value = {0};
    size_t at2 = 0;
    pf g;
    while (pr_next(f.p, f.n, &at2, &g) == 1) {
      if (g.field == 1 && g.wire == 2) type = (str){(const char *)g.p, g.n};
      if (g.field == 2 && g.wire == 2) value = (str){(const char *)g.p, g.n};
    }
    if (str_eq_c(type, TYPE_URL_PREFIX "QuotaFailure")) {
      size_t at3 = 0;
      pf v;
      while (pr_next((const unsigned char *)value.p, value.n, &at3, &v) == 1) {
        if (v.field != 1 || v.wire != 2 || found_daily) continue;
        str quota_id = {0}, metric = {0};
        int has_value = 0;
        uint64_t qv = 0;
        size_t at4 = 0;
        pf w;
        while (pr_next(v.p, v.n, &at4, &w) == 1) {
          if (w.field == 5 && w.wire == 2) quota_id = (str){(const char *)w.p, w.n};
          if (w.field == 4 && w.wire == 2) metric = (str){(const char *)w.p, w.n};
          if (w.field == 7 && w.wire == 0) has_value = 1, qv = w.v;
        }
        /* the first violation of a per-day quota */
        if (icontains(quota_id, "PerDay") || icontains(metric, "per_day") || icontains(metric, "PerDay")) {
          found_daily = 1;
          d->has_daily = 1;
          d->free_tier = icontains(quota_id, "FreeTier");
          d->has_limit = has_value && qv > 0;
          d->limit = (double)qv;
        }
      }
    } else if (str_eq_c(type, TYPE_URL_PREFIX "RetryInfo")) {
      int64_t seconds = 0, nanos = 0;
      size_t at3 = 0;
      pf v;
      while (pr_next((const unsigned char *)value.p, value.n, &at3, &v) == 1) {
        if (v.field != 1 || v.wire != 2) continue;
        size_t at4 = 0;
        pf w;
        while (pr_next(v.p, v.n, &at4, &w) == 1) {
          if (w.field == 1 && w.wire == 0) seconds = (int64_t)w.v;
          if (w.field == 2 && w.wire == 0) nanos = (int32_t)w.v;
        }
      }
      d->has_delay = 1;
      d->delay_ms = (int64_t)ceil((double)seconds * 1000 + (double)nanos / 1e6);
    }
  }
}

str gem_daily_quota_message(arena *a, const char *model, int free_tier, int has_limit, double limit, int has_resets,
                            int64_t resets_in_ms) {
  buf b = {0};
  if (free_tier) {
    buf_c(&b, "Gemini's free tier allows ");
    js_num(&b, has_limit ? limit : 10);
    buf_fmt(&b, " requests per day per model, and today's are used up for %s. Enable billing for your Gemini API key's "
                "project in Google AI Studio (" GEMINI_KEY_PAGE ") to lift the limit, or try again tomorrow.", model);
  } else {
    buf_c(&b, "Your Gemini project's daily limit");
    if (has_limit) {
      buf_c(&b, " of ");
      js_num(&b, limit);
      buf_c(&b, " requests");
    }
    buf_fmt(&b, " for %s is used up.", model);
    if (has_resets) {
      double hours = floor((double)resets_in_ms / 3600000.0 + 0.5);
      buf_fmt(&b, " It resets in about %.0f hour(s).", hours < 1 ? 1 : hours);
    }
    buf_c(&b, " A higher usage tier raises it (Google AI Studio, " GEMINI_KEY_PAGE ").");
  }
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

/* ---- the channel and the call ---- */
static const char *const GRPC_CODES[] = {
  "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
  "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE",
  "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED"};
static int fatal_code(int c) { return c == 1 || c == 3 || c == 5 || c == 6 || c == 7 || c == 9 || c == 10 || c == 11 || c == 16; }

static cb_h2_channel *g_channel;
static char g_origin[256], g_hostport[256];
static gate *g_gate;

void gem_set_gate(gate *g) { g_gate = g; }

int gem_open(char *err, size_t cap) {
  const char *base = getenv("GEMINI_API_BASE");
  if (!base || !*base) base = GEMINI_API_BASE;
  /* new URL(baseUrl).origin: the scheme, host and port, nothing after them. */
  const char *sep = strstr(base, "://");
  if (!sep) {
    snprintf(err, cap, "GEMINI_API_BASE is not a URL: %s", base);
    return -1;
  }
  const char *host = sep + 3;
  size_t hn = strcspn(host, "/?#");
  snprintf(g_origin, sizeof g_origin, "%.*s%.*s", (int)(host - base), base, (int)hn, host);
  snprintf(g_hostport, sizeof g_hostport, "%.*s", (int)hn, host);
  int rc = cb_h2_channel_new(g_origin, NULL, &g_channel);
  if (rc != 0) {
    snprintf(err, cap, "the Gemini channel to %s does not open", g_origin);
    return -1;
  }
  if (!g_gate) g_gate = gate_shared();
  return 0;
}

void gem_close(void) {
  if (g_channel) cb_h2_channel_free(g_channel);
  g_channel = NULL;
}

static void sleep_ms(int64_t ms) {
  struct timespec ts = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

/* What Node's http2 said when the call got no answer. */
static str no_answer(arena *a, const cb_grpc_reply *r) {
  if (r->resp.why == CB_H2_WHY_TIMEOUT) return str_c(ar_fmt(a, "no answer within %d ms", REQUEST_TIMEOUT_MS));
  if (r->resp.why == CB_H2_WHY_CONNECT) return str_c(ar_fmt(a, "connect ECONNREFUSED %s", g_hostport));
  return str_c(ar_dup(a, r->resp.err, strlen(r->resp.err)));
}

/* reply.message.replace(/\s+/g, ' ').trim().slice(0, 300), in UTF-16 units. */
static str grpc_message(arena *a, str m) {
  buf b = {0};
  int space = 0;
  for (size_t at = 0; at < m.n;) {
    size_t from = at;
    uint32_t cp = utf8_next(m, &at);
    if (js_space(cp)) {
      if (!space) buf_ch(&b, ' ');
      space = 1;
    } else {
      buf_put(&b, m.p + from, at - from);
      space = 0;
    }
  }
  str t = js_trim(buf_str(a, &b));
  buf_free(&b);
  size_t units = 0, at = 0;
  while (at < t.n) {
    size_t from = at;
    uint32_t cp = utf8_next(t, &at);
    size_t u = cp >= 0x10000 ? 2 : 1;
    if (units + u > 300) return str_sub(t, 0, from);
    units += u;
  }
  return t;
}

int gem_generate(arena *a, const char *model, const gem_request *req, gem_response *out, gem_err *e) {
  if (!g_channel) return gem_fail(a, e, GE_FATAL, "%s", MISSING_KEY_MESSAGE), -1;
  const char *key = getenv("GEMINI_API_KEY");
  if (!key || !*key) return gem_fail(a, e, GE_FATAL, "%s", MISSING_KEY_MESSAGE), -1;
  buf body = {0};
  gem_encode(&body, model, req);
  int64_t waited = 0;
  int rc = -1;
  cb_grpc_reply r;
  cb_grpc_reply_init(&r);
  for (;;) {
    int64_t wait = gate_acquire(g_gate, model);
    if (wait > 0) {
      if (waited + wait > MAX_RATE_LIMIT_WAIT_MS) {
        gem_fail(a, e, GE_RATE, "Gemini is limiting how many requests %s takes per minute and asked to wait %llds.", model,
                 (long long)((wait + 999) / 1000));
        e->retry_after_ms = wait;
        break;
      }
      sleep_ms(wait);
      waited += wait;
      continue;
    }
    cb_h2_field meta = {"x-goog-api-key", key, 14, strlen(key), true};
    cb_grpc_reply_free(&r);
    int call = cb_grpc_unary(g_channel, GENERATE_CONTENT_PATH, &meta, 1, body.p, body.n, REQUEST_TIMEOUT_MS, 0, &r);
    if (call != 0) {
      str why = call == CB_E_IO ? no_answer(a, &r) : str_c(ar_dup(a, r.resp.err, strlen(r.resp.err)));
      gem_fail(a, e, GE_ERROR, "Gemini request to %s failed: %.*s", model, (int)why.n, why.p);
      break;
    }
    if (r.code == RESOURCE_EXHAUSTED || (r.code == -1 && r.http_status == 429)) {
      details d;
      read_details(r.details.p, r.details.len, &d);
      if (d.has_daily) {
        str m = gem_daily_quota_message(a, model, d.free_tier, d.has_limit, d.limit, d.has_delay, d.delay_ms);
        gem_fail(a, e, GE_DAILY, "%.*s", (int)m.n, m.p);
        break;
      }
      gate_record(g_gate, model, 1, d.has_delay ? d.delay_ms : -1);
      continue;
    }
    if (r.code == -1) {
      int fatal = r.http_status >= 400 && r.http_status < 500;
      gem_fail(a, e, fatal ? GE_FATAL : GE_ERROR, "Gemini request to %s failed (HTTP %d)", model, r.http_status);
      break;
    }
    if (r.code != 0) {
      str m = grpc_message(a, (str){(const char *)r.message.p ? (const char *)r.message.p : "", r.message.len});
      const char *name = r.code >= 0 && r.code < (int)(sizeof GRPC_CODES / sizeof *GRPC_CODES) ? GRPC_CODES[r.code] : NULL;
      char codebuf[32];
      if (!name) snprintf(codebuf, sizeof codebuf, "gRPC %d", r.code), name = codebuf;
      gem_fail(a, e, fatal_code(r.code) ? GE_FATAL : GE_ERROR, "Gemini request to %s failed (%s)%s%.*s", model, name,
               m.n ? ": " : "", (int)m.n, m.p);
      break;
    }
    if (!r.has_msg) {
      gem_fail(a, e, GE_ERROR, "Gemini (%s) answered with 0 messages instead of one", model);
      break;
    }
    rd reader = {a, NULL};
    str block;
    if (read_response(&reader, r.msg, r.msg_len, out, &block)) {
      gem_fail(a, e, GE_ERROR, "Gemini (%s) returned a response that does not decode: %s", model, reader.error);
      break;
    }
    gate_record(g_gate, model, 0, -1);
    if (block.p) {
      gem_fail(a, e, GE_FATAL, "Gemini refused this request (%.*s).", (int)block.n, block.p);
      break;
    }
    rc = 0;
    break;
  }
  cb_grpc_reply_free(&r);
  buf_free(&body);
  return rc;
}

/* ---- speech ---- */
const char *gem_pick_voice(const char *previous) {
  const char *pool[NVOICES];
  size_t n = 0;
  for (size_t i = 0; i < NVOICES; i++)
    if (!previous || strcmp(VOICES[i], previous) != 0) pool[n++] = VOICES[i];
  /* random.int(n): one draw */
  return pool[(size_t)floor((double)rng_uint32() / 4294967296.0 * (double)n)];
}

static void le16(buf *b, uint32_t v) {
  buf_ch(b, (char)(v & 0xff));
  buf_ch(b, (char)(v >> 8 & 0xff));
}
static void le32(buf *b, uint32_t v) {
  le16(b, v & 0xffff);
  le16(b, v >> 16);
}

str gem_pcm_to_wav(arena *a, str pcm, uint32_t rate, uint32_t channels) {
  buf b = {0};
  uint32_t block = channels * 2;
  buf_c(&b, "RIFF");
  le32(&b, 36 + (uint32_t)pcm.n);
  buf_c(&b, "WAVEfmt ");
  le32(&b, 16);
  le16(&b, 1);
  le16(&b, channels);
  le32(&b, rate);
  le32(&b, rate * block);
  le16(&b, block);
  le16(&b, 16);
  buf_c(&b, "data");
  le32(&b, (uint32_t)pcm.n);
  buf_s(&b, pcm);
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

static int is_wav(str b) { return b.n >= 12 && !memcmp(b.p, "RIFF", 4) && !memcmp(b.p + 8, "WAVE", 4); }

/* /^audio\/(?:x-)?wav\b|^audio\/wave\b/ and /^audio\/(?:l16|pcm)\b/ on the lowercased type */
static int word_end(str m, size_t at) { return at >= m.n || !(isalnum((unsigned char)m.p[at]) || m.p[at] == '_'); }
static int prefix_word(str m, const char *p) { size_t n = strlen(p); return m.n >= n && !memcmp(m.p, p, n) && word_end(m, n); }
static int mime_wav(str m) { return prefix_word(m, "audio/wav") || prefix_word(m, "audio/x-wav") || prefix_word(m, "audio/wave"); }
static int mime_pcm(str m) { return prefix_word(m, "audio/l16") || prefix_word(m, "audio/pcm"); }

/* /\b<key>=(\d+)/: the first place the key starts a word and is followed by '=' and digits */
static int is_word(char c) { return isalnum((unsigned char)c) || c == '_'; }
static int mime_param(str m, const char *key, double *v) {
  size_t k = strlen(key);
  for (size_t i = 0; i + k + 1 < m.n + 1; i++) {
    if (i > 0 && is_word(m.p[i - 1])) continue;
    if (i + k + 1 > m.n || memcmp(m.p + i, key, k) || m.p[i + k] != '=') continue;
    size_t at = i + k + 1, d = at;
    while (d < m.n && m.p[d] >= '0' && m.p[d] <= '9') d++;
    if (d == at) continue;
    double acc = 0;
    for (size_t j = at; j < d; j++) acc = acc * 10 + (m.p[j] - '0');
    *v = acc;
    return 1;
  }
  return 0;
}

int gem_audio_to_wav(arena *a, str mime, str bytes, str *wav, str *error) {
  str m = {0};
  {
    char *low = ar_alloc(a, mime.n + 1);
    for (size_t i = 0; i < mime.n; i++) low[i] = (char)tolower((unsigned char)mime.p[i]);
    m = (str){low, mime.n};
  }
  if (mime_wav(m)) {
    if (!is_wav(bytes)) return *error = str_c(ar_fmt(a, "Gemini said %.*s but the bytes have no RIFF/WAVE header", (int)mime.n, mime.p)), -1;
    *wav = bytes;
    return 0;
  }
  if (mime_pcm(m)) {
    double rate = 24000, channels = 1;
    mime_param(m, "rate", &rate);
    mime_param(m, "channels", &channels);
    if (!(rate > 0) || !(channels > 0)) return *error = str_c(ar_fmt(a, "Gemini audio has an unusable format: %.*s", (int)mime.n, mime.p)), -1;
    *wav = gem_pcm_to_wav(a, bytes, (uint32_t)rate, (uint32_t)channels);
    return 0;
  }
  *error = str_c(ar_fmt(a, "Gemini returned audio in an unexpected format: %.*s", mime.n ? (int)mime.n : 12,
                        mime.n ? mime.p : "no mime type"));
  return -1;
}

int gem_synthesize(arena *a, str text, const char *voice, str *wav, gem_err *e) {
  gem_request req = {0};
  req.parts[0].text = text;
  req.nparts = 1;
  req.voice = voice;
  gem_response r;
  if (gem_generate(a, TTS_MODEL, &req, &r, e)) return -1;
  gem_part_out *audio[64];
  size_t n = 0;
  for (size_t i = 0; i < r.nparts && n < 64; i++)
    if (r.parts[i].has_inline && r.parts[i].has_data) audio[n++] = &r.parts[i]; /* part.inlineData?.data */
  if (!n) {
    gem_fail(a, e, GE_ERROR, "Gemini returned no audio (finishReason: %.*s)", r.finish_reason.n ? (int)r.finish_reason.n : 4,
             r.finish_reason.n ? r.finish_reason.p : "none");
    return -1;
  }
  int all_pcm = n > 1;
  for (size_t i = 0; i < n && all_pcm; i++) {
    char *low = ar_alloc(a, audio[i]->mime.n + 1);
    for (size_t k = 0; k < audio[i]->mime.n; k++) low[k] = (char)tolower((unsigned char)audio[i]->mime.p[k]);
    all_pcm = mime_pcm((str){low, audio[i]->mime.n});
  }
  str bytes = audio[0]->data, error;
  if (all_pcm) {
    buf joined = {0};
    for (size_t i = 0; i < n; i++) buf_s(&joined, audio[i]->data);
    bytes = buf_str(a, &joined);
    buf_free(&joined);
  }
  if (gem_audio_to_wav(a, audio[0]->mime, bytes, wav, &error)) {
    gem_fail(a, e, GE_ERROR, "%.*s", (int)error.n, error.p);
    return -1;
  }
  return 0;
}
