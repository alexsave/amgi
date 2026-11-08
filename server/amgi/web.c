/* What every route shares: ui/server/serve.mjs's answers, src/server/anki/settings.js's headers,
 * respond.js's not-ready answer, and the JavaScript built-ins the handlers leaned on (Number(),
 * decodeURIComponent, URLSearchParams.get). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "amgi.h"
#include "messages.h"

static int hexval(int ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}

/* A whole UTF-8 sequence at p[0..n): its length, or 0 when it is not one (decodeURIComponent's
 * octet rules: no overlong form, no surrogate, nothing past U+10FFFF). */
static size_t utf8_ok(const unsigned char *p, size_t n) {
  if (p[0] < 0x80) return 1;
  size_t len;
  uint32_t cp, min;
  if ((p[0] & 0xe0) == 0xc0) len = 2, cp = p[0] & 0x1f, min = 0x80;
  else if ((p[0] & 0xf0) == 0xe0) len = 3, cp = p[0] & 0x0f, min = 0x800;
  else if ((p[0] & 0xf8) == 0xf0) len = 4, cp = p[0] & 0x07, min = 0x10000;
  else return 0;
  if (n < len) return 0;
  for (size_t i = 1; i < len; i++) {
    if ((p[i] & 0xc0) != 0x80) return 0;
    cp = cp << 6 | (p[i] & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  return len;
}

int amgi_uri_decode(arena *a, str raw, str *out) {
  buf bytes = {0};
  for (size_t i = 0; i < raw.n; i++) {
    unsigned char ch = (unsigned char)raw.p[i];
    if (ch == '%') {
      if (i + 2 >= raw.n) goto bad;
      int hi = hexval(raw.p[i + 1]), lo = hexval(raw.p[i + 2]);
      if (hi < 0 || lo < 0) goto bad;
      buf_ch(&bytes, (char)(hi * 16 + lo));
      i += 2;
    } else if (ch >= 0x80) {
      /* A header is read as Latin-1: the byte is that code point. */
      utf8_put(&bytes, ch);
    } else {
      buf_ch(&bytes, (char)ch);
    }
  }
  for (size_t i = 0; i < bytes.n;) {
    size_t k = utf8_ok((const unsigned char *)bytes.p + i, bytes.n - i);
    if (!k) goto bad;
    i += k;
  }
  *out = buf_str(a, &bytes);
  buf_free(&bytes);
  return 1;
bad:
  buf_free(&bytes);
  return 0;
}

static str header(arena *a, const cb_http_req *req, const char *name) {
  const char *raw = cb_http_header_get(req, name);
  if (!raw || !*raw) return S("");
  str out;
  return amgi_uri_decode(a, str_c(raw), &out) ? out : S("");
}

void amgi_read_settings(arena *a, const cb_http_req *req, amgi_settings *out) {
  out->base_dir_override = header(a, req, "x-amgi-base-dir");
  out->collection_path = header(a, req, "x-amgi-collection");
  out->profile_name = header(a, req, "x-amgi-profile");
  out->bridge_url = header(a, req, "x-amgi-bridge-url");
  out->bridge_token = header(a, req, "x-amgi-bridge-token");
}

col_settings amgi_col_settings(const amgi_settings *s) {
  col_settings c = {s->collection_path, s->bridge_url, s->bridge_token};
  return c;
}

/* The WHATWG form-urlencoded parser's decoding: '+' is a space, a %XX escape is its byte, anything
 * else (a bad escape included) is kept, and the bytes are read as UTF-8 with replacement. */
static str form_decode(arena *a, const char *p, size_t n) {
  buf b = {0};
  for (size_t i = 0; i < n; i++) {
    if (p[i] == '+') {
      buf_ch(&b, ' ');
    } else if (p[i] == '%' && i + 2 < n && hexval((unsigned char)p[i + 1]) >= 0 && hexval((unsigned char)p[i + 2]) >= 0) {
      buf_ch(&b, (char)(hexval(p[i + 1]) * 16 + hexval(p[i + 2])));
      i += 2;
    } else {
      buf_ch(&b, p[i]);
    }
  }
  str raw = buf_str(a, &b);
  buf_free(&b);
  return utf8_clean(a, raw);
}

int amgi_query_get(arena *a, const char *query, const char *key, str *out) {
  size_t klen = strlen(key);
  const char *p = query ? query : "";
  while (*p) {
    const char *amp = strchr(p, '&');
    size_t len = amp ? (size_t)(amp - p) : strlen(p);
    if (len) {
      const char *eq = memchr(p, '=', len);
      size_t nlen = eq ? (size_t)(eq - p) : len;
      str name = form_decode(a, p, nlen);
      if (name.n == klen && !memcmp(name.p, key, klen)) {
        *out = eq ? form_decode(a, eq + 1, len - nlen - 1) : S("");
        return 1;
      }
    }
    if (!amp) break;
    p = amp + 1;
  }
  return 0;
}

/* ---- Number(string) ---- */
static int digits_in(const char *p, size_t n, int base, double *v) {
  if (!n) return 0;
  double acc = 0;
  for (size_t i = 0; i < n; i++) {
    int d = hexval((unsigned char)p[i]);
    if (d < 0 || d >= base) return 0;
    acc = acc * base + d;
  }
  *v = acc;
  return 1;
}

double amgi_js_number(str s) {
  str t = js_trim(s);
  if (!t.n) return 0;
  const char *p = t.p;
  size_t n = t.n;
  if (n > 2 && p[0] == '0') {
    int base = (p[1] == 'x' || p[1] == 'X') ? 16 : (p[1] == 'o' || p[1] == 'O') ? 8 : (p[1] == 'b' || p[1] == 'B') ? 2 : 0;
    if (base) {
      double v;
      return digits_in(p + 2, n - 2, base, &v) ? v : NAN;
    }
  }
  size_t i = 0;
  int neg = 0;
  if (p[0] == '+' || p[0] == '-') neg = p[0] == '-', i = 1;
  if (n - i == 8 && !memcmp(p + i, "Infinity", 8)) return neg ? -INFINITY : INFINITY;
  /* StrUnsignedDecimalLiteral: digits [. digits] [e [+-] digits], or . digits [e ...] */
  size_t at = i, intd = 0, fracd = 0;
  while (at < n && p[at] >= '0' && p[at] <= '9') at++, intd++;
  if (at < n && p[at] == '.') {
    at++;
    while (at < n && p[at] >= '0' && p[at] <= '9') at++, fracd++;
  }
  if (!intd && !fracd) return NAN;
  if (at < n && (p[at] == 'e' || p[at] == 'E')) {
    at++;
    if (at < n && (p[at] == '+' || p[at] == '-')) at++;
    size_t expd = 0;
    while (at < n && p[at] >= '0' && p[at] <= '9') at++, expd++;
    if (!expd) return NAN;
  }
  if (at != n) return NAN;
  char tmp[512];
  if (n >= sizeof tmp) {
    char *big = malloc(n + 1);
    if (!big) return NAN;
    memcpy(big, p, n);
    big[n] = 0;
    double v = strtod(big, NULL);
    free(big);
    return v;
  }
  memcpy(tmp, p, n);
  tmp[n] = 0;
  return strtod(tmp, NULL);
}

str amgi_param(const cb_http_req *req, const char *name) {
  size_t k = strlen(name);
  for (unsigned i = 0; i < req->n_params; i++)
    if (req->params[i].name_len == k && !memcmp(req->params[i].name, name, k))
      return (str){req->params[i].value, req->params[i].value_len};
  return S("");
}

/* ---- answers ---- */
uint32_t amgi_u32(double v) {
  if (v != v) return 0;
  if (v <= 0) return 0;
  if (v >= 4294967295.0) return 0xffffffffu;
  return (uint32_t)(v + 0.5);
}
wire_str amgi_ws(str s) { return (wire_str){s.p ? s.p : "", (uint32_t)s.n}; }
str amgi_str(wire_str w) { return (str){w.p ? w.p : "", w.len}; }

void amgi_send_text(cb_http_res *res, int status, str text) {
  cb_res_send(res, status, "text/plain", text.p, text.n);
  cb_res_header(res, "Cache-Control", "no-store");
}

void amgi_send_wire(arena *a, cb_http_res *res, int status, uint32_t kind, const void *msg) {
  (void)a;
  wire_buf b = {0, 0, 0};
  wire_encode(&b, kind, msg);
  cb_res_send(res, status, WIRE_MIME, b.p, b.len);
  cb_res_header(res, "Cache-Control", "no-store");
  free(b.p);
}

void amgi_send_error(arena *a, cb_http_res *res, int status, const amgi_error *e) {
  wire_error w = {0};
  w.mode = e->mode ? wire_mode_of(e->mode, (uint32_t)strlen(e->mode)) : WIRE_MODE_OTHER;
  w.error = amgi_ws(e->error);
  w.retry_after_ms = e->has_retry ? e->retry_after_ms : WIRE_NONE;
  w.max_wait_ms = e->has_retry ? MAX_WAIT_MS : WIRE_NONE;
  w.not_started = (uint8_t)(e->not_started ? 1 : 0);
  w.daily_cap = (uint8_t)(e->daily_cap ? 1 : 0);
  if (e->has_retry) {
    /* rateLimit.js: Retry-After is the wait in whole seconds, at least one. */
    char secs[24];
    uint32_t s = (uint32_t)((e->retry_after_ms + 999u) / 1000u);
    snprintf(secs, sizeof secs, "%u", s < 1 ? 1u : s);
    cb_res_header(res, "Retry-After", secs);
  }
  amgi_send_wire(a, res, status, WK_ERROR, &w);
}

void amgi_send_message(arena *a, cb_http_res *res, int status, str message) {
  amgi_error e = {0};
  e.error = message;
  amgi_send_error(a, res, status, &e);
}

void amgi_not_ready(arena *a, cb_http_res *res, const char *mode) {
  static const struct { const char *mode, *text; } MESSAGES[] = {
    {"unconfigured", MSG_UNCONFIGURED},
    {"not-found", MSG_NOT_FOUND},
    {"unsupported-schema", MSG_UNSUPPORTED_SCHEMA},
    {"locked", MSG_LOCKED},
    {"bridge-outdated", MSG_BRIDGE_OUTDATED},
    {"bridge-no-collection", MSG_BRIDGE_NO_COLLECTION},
  };
  amgi_error e = {0};
  e.mode = mode;
  for (size_t i = 0; i < sizeof MESSAGES / sizeof *MESSAGES; i++)
    if (!strcmp(MESSAGES[i].mode, mode)) e.error = str_c(MESSAGES[i].text);
  if (!e.error.p) e.error = str_c(ar_fmt(a, "Anki collection is not available (%s).", mode));
  amgi_send_error(a, res, 409, &e);
}

str amgi_root(arena *a) {
  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) return S(".");
  return str_c(ar_dup(a, cwd, strlen(cwd)));
}

/* ---- plusaudio/lib/audio-store.js mediaName, and deck.js renderAudioReference ---- */
str amgi_media_name(arena *a, str text, str language, const char *extension) {
  buf b = {0};
  buf_c(&b, "v1\n");
  buf_s(&b, language);
  buf_ch(&b, '\n');
  buf_s(&b, text);
  char hex[41];
  sha1_hex(b.p, b.n, hex);
  buf_free(&b);
  return str_c(ar_fmt(a, "plusaudio-%.20s.%s", hex, extension));
}

str amgi_audio_reference(arena *a, str filename) {
  return str_cat3(a, S("<audio src=\""), filename, S("\"></audio>"));
}
