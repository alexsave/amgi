/* amgi's wire format: see wire.h for the layouts. */
#include "wire.h"

static const char *const MODE_NAMES[WIRE_MODES] = {
  "direct", "bridge", "locked", "not-found", "unsupported-schema", "bridge-no-collection", "unconfigured", "",
};

const char *wire_mode_name(uint32_t mode) { return mode < WIRE_MODES ? MODE_NAMES[mode] : ""; }

uint32_t wire_mode_of(const char *s, uint32_t len) {
  for (uint32_t m = 0; m < WIRE_MODE_OTHER; m++) {
    const char *n = MODE_NAMES[m];
    uint32_t k = 0;
    while (k < len && n[k] && n[k] == s[k]) k++;
    if (k == len && !n[k]) return m;
  }
  return WIRE_MODE_OTHER;
}

/* ---- reading ---- */
static uint32_t r_u8(wire_in *in) {
  if (in->bad || in->end - in->p < 1) return in->bad = 1, 0;
  return *in->p++;
}
static uint32_t r_u32(wire_in *in) {
  if (in->bad || in->end - in->p < 4) return in->bad = 1, 0;
  const uint8_t *p = in->p;
  in->p += 4;
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static int64_t r_i64(wire_in *in) {
  uint64_t lo = r_u32(in), hi = r_u32(in);
  return (int64_t)(lo | hi << 32);
}
static wire_str r_str(wire_in *in) {
  wire_str s = {0, 0};
  uint32_t n = r_u32(in);
  if (in->bad || (uint32_t)(in->end - in->p) < n) return in->bad = 1, s;
  s.p = (const char *)in->p;
  s.len = n;
  in->p += n;
  return s;
}
/* Opens p, len as an answer of kind; 0 when it is not one. */
static int r_open(wire_in *in, const uint8_t *p, uint32_t len, uint32_t kind) {
  in->p = p;
  in->end = p + len;
  in->bad = 0;
  if (r_u32(in) != WIRE_MAGIC) return 0;
  return r_u8(in) == kind && !in->bad;
}
/* The answer read to its last byte, and no further. */
static int r_done(wire_in *in) { return !in->bad && in->p == in->end; }

int32_t wire_kind(const uint8_t *p, uint32_t len) {
  wire_in in = {p, p + len, 0, 0};
  if (r_u32(&in) != WIRE_MAGIC) return -1;
  uint32_t k = r_u8(&in);
  return in.bad ? -1 : (int32_t)k;
}

int wire_read_error(const uint8_t *p, uint32_t len, wire_error *out) {
  wire_in in;
  if (!r_open(&in, p, len, WIRE_ERROR)) return 0;
  out->mode = r_u8(&in);
  out->retry_after_ms = r_u32(&in);
  out->flags = r_u8(&in);
  out->error = r_str(&in);
  return r_done(&in);
}

int wire_read_status(const uint8_t *p, uint32_t len, wire_status *out) {
  wire_in in;
  if (!r_open(&in, p, len, WIRE_STATUS)) return 0;
  out->mode = r_u8(&in);
  out->schema_version = r_u32(&in);
  out->detail = r_str(&in);
  return r_done(&in);
}

int wire_decks_open(wire_in *in, const uint8_t *p, uint32_t len, uint32_t *mode, uint32_t *n) {
  if (!r_open(in, p, len, WIRE_DECKS)) return 0;
  *mode = r_u8(in);
  *n = in->left = r_u32(in);
  return !in->bad;
}
int wire_decks_next(wire_in *in, wire_deck *out) {
  if (!in->left || in->bad) return 0;
  in->left--;
  out->id = r_i64(in);
  out->note_count = r_u32(in);
  out->name = r_str(in);
  return !in->bad;
}
int wire_decks_check(const uint8_t *p, uint32_t len) {
  wire_in in;
  uint32_t mode, n;
  wire_deck d;
  if (!wire_decks_open(&in, p, len, &mode, &n)) return 0;
  for (uint32_t i = 0; i < n; i++)
    if (!wire_decks_next(&in, &d)) return 0;
  return r_done(&in);
}

int wire_read_install(const uint8_t *p, uint32_t len, wire_install *out) {
  wire_in in;
  if (!r_open(&in, p, len, WIRE_INSTALL)) return 0;
  out->installed = r_u8(&in);
  out->up_to_date = r_u8(&in);
  out->collection_checked = r_u8(&in);
  out->stale_count = r_u32(&in);
  out->ready = r_u8(&in);
  return r_done(&in);
}

int wire_profiles_open(wire_in *in, const uint8_t *p, uint32_t len, wire_str *base_dir, uint32_t *exists, uint32_t *n) {
  if (!r_open(in, p, len, WIRE_PROFILES)) return 0;
  *base_dir = r_str(in);
  *exists = r_u8(in);
  *n = in->left = r_u32(in);
  return !in->bad;
}
int wire_profiles_next(wire_in *in, wire_profile *out) {
  if (!in->left || in->bad) return 0;
  in->left--;
  out->name = r_str(in);
  out->collection_path = r_str(in);
  return !in->bad;
}

/* ---- writing ---- */
static uint8_t *w_room(wire_buf *b, uint32_t n) {
  if (b->cap - b->len < n) {
    uint32_t cap = b->cap ? b->cap : 256;
    while (cap - b->len < n) cap *= 2;
    b->p = wire_grow(b->p, b->len, cap);
    b->cap = cap;
  }
  uint8_t *at = b->p + b->len;
  b->len += n;
  return at;
}
static void w_u8(wire_buf *b, uint32_t v) { *w_room(b, 1) = (uint8_t)v; }
static void w_u32(wire_buf *b, uint32_t v) {
  uint8_t *p = w_room(b, 4);
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}
static void w_i64(wire_buf *b, int64_t v) {
  w_u32(b, (uint32_t)(uint64_t)v);
  w_u32(b, (uint32_t)((uint64_t)v >> 32));
}
static void w_str(wire_buf *b, const char *s, uint32_t n) {
  w_u32(b, n);
  if (n) __builtin_memcpy(w_room(b, n), s, n);
}

void wire_begin(wire_buf *b, uint32_t kind) {
  b->len = 0;
  w_u32(b, WIRE_MAGIC);
  w_u8(b, kind);
}
void wire_w_error(wire_buf *b, const char *mode, uint32_t mlen, uint32_t retry_after_ms, uint32_t flags,
                  const char *err, uint32_t elen) {
  w_u8(b, wire_mode_of(mode, mlen));
  w_u32(b, retry_after_ms);
  w_u8(b, flags);
  w_str(b, err, elen);
}
void wire_w_status(wire_buf *b, const char *mode, uint32_t mlen, uint32_t schema_version, const char *detail,
                   uint32_t dlen) {
  w_u8(b, wire_mode_of(mode, mlen));
  w_u32(b, schema_version);
  w_str(b, detail, dlen);
}
void wire_w_decks_head(wire_buf *b, const char *mode, uint32_t mlen, uint32_t n) {
  w_u8(b, wire_mode_of(mode, mlen));
  w_u32(b, n);
}
void wire_w_deck(wire_buf *b, int64_t id, uint32_t note_count, const char *name, uint32_t nlen) {
  w_i64(b, id);
  w_u32(b, note_count);
  w_str(b, name, nlen);
}
void wire_w_install(wire_buf *b, uint32_t installed, uint32_t up_to_date, uint32_t collection_checked,
                    uint32_t stale_count, uint32_t ready) {
  w_u8(b, installed);
  w_u8(b, up_to_date);
  w_u8(b, collection_checked);
  w_u32(b, stale_count);
  w_u8(b, ready);
}
void wire_w_profiles_head(wire_buf *b, const char *base_dir, uint32_t blen, uint32_t exists, uint32_t n) {
  w_str(b, base_dir, blen);
  w_u8(b, exists);
  w_u32(b, n);
}
void wire_w_profile(wire_buf *b, const char *name, uint32_t nlen, const char *path, uint32_t plen) {
  w_str(b, name, nlen);
  w_str(b, path, plen);
}
