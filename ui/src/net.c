/* Requests to /api/anki in amgi's wire format, the settings as the five plain headers, and the
 * answer routed back to the module that asked (its id in the token's top byte). */
#include "app.h"

#define DEADLINE_MS 15000
#define SLOW_DEADLINE_MS 600000 /* a card's text and clips: Gemini, and its rate gate's waits */
static const char PREFIX[] = "/api/anki";
static const char ACCEPT[] = "Accept: " WIRE_MIME "\n";
static const char CONTENT[] = "Content-Type: " WIRE_MIME "\n";

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) {
  (void)len;
  return cd_realloc(p, cap);
}

static wire_buf body_buf;

static void request(uint32_t token, const char *method, const char *path, uint32_t plen, int has_body, uint32_t deadline,
                    const text *with) {
  uint32_t ulen = (uint32_t)sizeof PREFIX - 1 + plen;
  char *url = cd_alloc(ulen);
  __builtin_memcpy(url, PREFIX, sizeof PREFIX - 1);
  __builtin_memcpy(url + sizeof PREFIX - 1, path, plen);
  uint32_t room = (uint32_t)(sizeof ACCEPT + sizeof CONTENT) + settings_room(with ? with : settings);
  char *headers = cd_alloc(room);
  uint32_t h = sizeof ACCEPT - 1;
  __builtin_memcpy(headers, ACCEPT, h);
  if (has_body) {
    __builtin_memcpy(headers + h, CONTENT, sizeof CONTENT - 1);
    h += sizeof CONTENT - 1;
  }
  if (with) h += settings_block(headers + h, with);
  else if (settings_stored) h += settings_block(headers + h, settings);
  cd_http(token, method, zlen(method), url, ulen, headers, h, has_body ? body_buf.p : 0, has_body ? body_buf.len : 0,
          deadline);
  cd_free(headers);
  cd_free(url);
}

void ask_as(const text *with, uint32_t module, uint32_t token, const char *method, const char *path, uint32_t qkind,
            const void *body) {
  int has_body = qkind != WIRE_NONE;
  if (has_body) wire_encode(&body_buf, qkind, body);
  int slow = qkind == WK_Q_CARD_TEXT || qkind == WK_Q_AUDIO || qkind == WK_Q_NOTES || qkind == WK_Q_STARTER;
  request(module << 24 | (token & 0xffffff), method, path, zlen(path), has_body, slow ? SLOW_DEADLINE_MS : DEADLINE_MS,
          with);
}
void ask(uint32_t module, uint32_t token, const char *method, const char *path, uint32_t qkind, const void *body) {
  ask_as(0, module, token, method, path, qkind, body);
}

void ask_media(uint32_t token, const char *name, uint32_t len) {
  static const char MEDIA[] = "/media/";
  char *path = cd_alloc((uint32_t)sizeof MEDIA + 3 * len);
  __builtin_memcpy(path, MEDIA, sizeof MEDIA - 1);
  uint32_t n = (uint32_t)sizeof MEDIA - 1 + cd_url_encode(path + sizeof MEDIA - 1, name, len);
  request((uint32_t)M_CHIP << 24 | (token & 0xffffff), "GET", path, n, 0, DEADLINE_MS, 0);
  cd_free(path);
}

void holder_free(holder *h) {
  cd_free(h->bytes);
  cd_free(h->mem);
  h->bytes = 0;
  h->mem = 0;
}

answer take(holder *h, uint32_t kind, uint32_t status, const uint8_t *p, uint32_t len, void *out) {
  answer a = {status, 0, {0}};
  a.err.retry_after_ms = a.err.max_wait_ms = WIRE_NONE;
  a.err.error = (wire_str){"", 0};
  holder_free(h);
  h->bytes = cd_alloc(len ? len : 1);
  if (len) __builtin_memcpy(h->bytes, p, len);
  int32_t k = wire_kind(h->bytes, len);
  uint32_t want = status >= 200 && status < 300 ? kind : WK_ERROR;
  uint32_t room = k == (int32_t)want ? wire_room(want, h->bytes, len) : WIRE_NONE;
  if (room == WIRE_NONE) return a;
  h->mem = cd_alloc(room ? room : 8);
  wire_decode(want, h->bytes, len, want == kind ? out : (void *)&a.err, h->mem);
  a.ok = want == kind;
  return a;
}

uint32_t answer_message(const answer *a, char *dst, uint32_t cap) {
  const char *m;
  uint32_t n;
  if (a->err.error.len) {
    m = a->err.error.p;
    n = a->err.error.len;
  } else {
    m = a->status == CD_HTTP_FAILED ? "amgi's server did not answer" : a->status == CD_HTTP_TIMEOUT ? "amgi's server took too long to answer"
                                                                  : "amgi's server sent an answer this page cannot read";
    n = zlen(m);
  }
  if (n > cap) n = cap;
  __builtin_memcpy(dst, m, n);
  return n;
}

void cd_on_http(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  uint32_t t = token & 0xffffff;
  switch (token >> 24) {
  case M_SHELL: state_answer(t, status, p, len); break; /* the state's own requests (state.c) */
  case M_SETTINGS: settings_answer(t, status, p, len); break;
  case M_DECK: deck_answer(t, status, p, len); break;
  case M_CHIP: chip_answer(t, status, p, len); break;
  case M_FIRSTRUN: firstrun_answer(t, status, p, len); break;
  case M_DECKS: decks_answer(t, status, p, len); break;
  case M_PANEL: panel_answer(t, status, p, len); break;
  case M_STARTER: starter_answer(t, status, p, len); break;
  case M_TEMPLATE: template_answer(t, status, p, len); break;
  }
}
