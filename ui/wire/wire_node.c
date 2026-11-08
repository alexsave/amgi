/* The wire writers as a wasm module for the Node server (ui/server/wire.mjs loads it as
 * ui/out/wire.wasm). Memory is one arena from __heap_base, emptied by every w_begin: an answer is
 * written start to end in one go, so nothing outlives it. The binding copies a call's strings into
 * w_scratch's room, then makes the call with pointers into it. */
#include "wire.h"

#define EXPORT(n) __attribute__((export_name(n)))

extern unsigned char __heap_base;
static uintptr_t top, end;
static wire_buf out;

static uint8_t *arena(uint32_t n) {
  if (!end) end = (uintptr_t)__builtin_wasm_memory_size(0) << 16;
  uintptr_t at = top, need = (at + n + 15) & ~(uintptr_t)15;
  if (need > end) {
    uint32_t pages = (uint32_t)((need - end + 65535) >> 16);
    if (__builtin_wasm_memory_grow(0, pages) < 0) __builtin_trap();
    end += (uintptr_t)pages << 16;
  }
  top = need;
  return (uint8_t *)at;
}

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) {
  uint8_t *q = arena(cap);
  if (len) __builtin_memcpy(q, p, len);
  return q;
}

EXPORT("w_begin") void w_begin(uint32_t kind) {
  top = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  out.p = 0;
  out.len = out.cap = 0;
  wire_begin(&out, kind);
}
EXPORT("w_scratch") uint8_t *w_scratch(uint32_t n) { return arena(n ? n : 1); }
EXPORT("w_ptr") uint8_t *w_ptr(void) { return out.p; }
EXPORT("w_len") uint32_t w_len(void) { return out.len; }

EXPORT("w_error") void w_error(const char *m, uint32_t ml, uint32_t retry, uint32_t flags, const char *e, uint32_t el) {
  wire_w_error(&out, m, ml, retry, flags, e, el);
}
EXPORT("w_status") void w_status(const char *m, uint32_t ml, uint32_t schema, const char *d, uint32_t dl) {
  wire_w_status(&out, m, ml, schema, d, dl);
}
EXPORT("w_decks_head") void w_decks_head(const char *m, uint32_t ml, uint32_t n) { wire_w_decks_head(&out, m, ml, n); }
EXPORT("w_deck") void w_deck(double id, uint32_t count, const char *name, uint32_t nl) {
  wire_w_deck(&out, (int64_t)id, count, name, nl);
}
EXPORT("w_install") void w_install(uint32_t installed, uint32_t up_to_date, uint32_t checked, uint32_t stale, uint32_t ready) {
  wire_w_install(&out, installed, up_to_date, checked, stale, ready);
}
EXPORT("w_profiles_head") void w_profiles_head(const char *b, uint32_t bl, uint32_t exists, uint32_t n) {
  wire_w_profiles_head(&out, b, bl, exists, n);
}
EXPORT("w_profile") void w_profile(const char *n, uint32_t nl, const char *p, uint32_t pl) {
  wire_w_profile(&out, n, nl, p, pl);
}
