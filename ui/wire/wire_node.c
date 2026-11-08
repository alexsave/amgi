/* The server's two walkers over the schema, built with wire.c as ui/out/wire.wasm for
 * ui/server/wire.mjs. They never see a JS object: they ask the binding for each field by the
 * schema's key name (imports js_*), so the binding knows no layout.
 *
 * Writing an answer: the binding holds the handler's object; w_encode(kind) walks the schema and
 * asks for each field's value. Reading a request: w_decode(kind) walks the bytes and tells the
 * binding each (key, value) to set on a new object.
 *
 * Memory is one arena from __heap_base, emptied at every call: a message is written or read start
 * to end in one go, so nothing outlives it. */
#include "wire.h"

#define EXPORT(n) __attribute__((export_name(n)))
#define IMPORT(n) __attribute__((import_module("wire"), import_name(n)))

/* The current object is the binding's; key, klen name a field of it (dotted for nested). */
IMPORT("num") double js_num(const char *key, uint32_t klen);           /* a number, true 1, false 0; NaN otherwise */
IMPORT("tri") uint32_t js_tri(const char *key, uint32_t klen);         /* true 1, false 0, else 2 */
IMPORT("str_len") uint32_t js_str_len(const char *key, uint32_t klen); /* a string's UTF-8 bytes (it is kept) */
IMPORT("str_copy") void js_str_copy(uint8_t *dst);                     /* the kept string's bytes */
IMPORT("bytes_len") uint32_t js_bytes_len(const char *key, uint32_t klen); /* a Uint8Array's length (it is kept for str_copy) */
IMPORT("count") uint32_t js_count(const char *key, uint32_t klen);     /* an array's length; 0 if none */
IMPORT("enter") void js_enter(const char *key, uint32_t klen, uint32_t i); /* the array's item i becomes current */
IMPORT("leave") void js_leave(void);
/* Building an object: */
IMPORT("set_num") void js_set_num(const char *key, uint32_t klen, double v);
IMPORT("set_bool") void js_set_bool(const char *key, uint32_t klen, uint32_t v);
IMPORT("set_str") void js_set_str(const char *key, uint32_t klen, const uint8_t *p, uint32_t len);
IMPORT("set_bytes") void js_set_bytes(const char *key, uint32_t klen, const uint8_t *p, uint32_t len); /* a copy, as a Buffer */
IMPORT("set_list") void js_set_list(const char *key, uint32_t klen); /* an empty array; items are pushed into it */
IMPORT("push_str") void js_push_str(const uint8_t *p, uint32_t len);   /* onto the array just made */
IMPORT("push_obj") void js_push_obj(void);  /* a new object onto it, which becomes current until js_leave */

extern unsigned char __heap_base;
static uintptr_t top, end;
static wire_buf out;

static void arena_reset(void) {
  top = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  if (!end) end = (uintptr_t)__builtin_wasm_memory_size(0) << 16;
}
static uint8_t *arena(uint32_t n) {
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

static uint32_t zlen(const char *s) {
  uint32_t n = 0;
  while (s[n]) n++;
  return n;
}
/* A JS number as the u32 the schema means: rounded, clamped; NaN as fallback. */
static uint32_t to_u32(double v, uint32_t fallback) {
  if (v != v) return fallback;
  if (v <= 0) return 0;
  if (v >= 4294967295.0) return 0xffffffffu;
  return (uint32_t)(v + 0.5);
}

/* ---- writing an answer from the binding's object ---- */
static void encode_js(const wire_schema *s) {
  for (uint32_t i = 0; i < s->n; i++) {
    const wire_field *f = &s->f[i];
    const char *k = f->key;
    uint32_t kl = zlen(k);
    switch (f->type) {
    case WT_BOOL: wire_u8(&out, js_tri(k, kl) == 1); break;
    case WT_TRI: wire_u8(&out, js_tri(k, kl)); break;
    case WT_U32: wire_u32(&out, to_u32(js_num(k, kl), 0)); break;
    case WT_OPT: wire_u32(&out, to_u32(js_num(k, kl), WIRE_NONE)); break;
    case WT_I32: {
      double v = js_num(k, kl);
      wire_u32(&out, v != v ? (uint32_t)WIRE_ABSENT : (uint32_t)(int32_t)v);
      break;
    }
    case WT_I64: {
      double v = js_num(k, kl);
      wire_i64(&out, v != v ? 0 : (int64_t)v);
      break;
    }
    case WT_BYTES: {
      uint32_t n = js_bytes_len(k, kl);
      uint8_t *p = arena(n ? n : 1);
      js_str_copy(p);
      wire_bytes(&out, p, n);
      break;
    }
    case WT_STR: case WT_MODE: {
      uint32_t n = js_str_len(k, kl);
      uint8_t *p = arena(n ? n : 1);
      js_str_copy(p);
      if (f->type == WT_MODE) wire_u8(&out, wire_mode_of((const char *)p, n));
      else wire_bytes(&out, p, n);
      break;
    }
    case WT_STRS: case WT_LIST: {
      uint32_t n = js_count(k, kl);
      wire_u32(&out, n);
      for (uint32_t j = 0; j < n; j++) {
        js_enter(k, kl, j);
        if (f->type == WT_LIST) {
          encode_js(f->sub);
        } else {
          uint32_t sl = js_str_len("", 0); /* the item itself */
          uint8_t *p = arena(sl ? sl : 1);
          js_str_copy(p);
          wire_bytes(&out, p, sl);
        }
        js_leave();
      }
      break;
    }
    }
  }
}
EXPORT("w_encode") void w_encode(uint32_t kind) {
  arena_reset();
  out = (wire_buf){0, 0, 0};
  wire_begin(&out, kind);
  encode_js(wire_schema_of(kind));
}
EXPORT("w_ptr") uint8_t *w_ptr(void) { return out.p; }
EXPORT("w_len") uint32_t w_len(void) { return out.len; }

/* ---- reading a request into a new object ---- */
static void decode_js(wire_in *in, const wire_schema *s) {
  for (uint32_t i = 0; i < s->n && !in->bad; i++) {
    const wire_field *f = &s->f[i];
    const char *k = f->key;
    uint32_t kl = zlen(k);
    switch (f->type) {
    case WT_BOOL: js_set_bool(k, kl, wire_r_u8(in) == 1); break;
    case WT_TRI: {
      uint32_t v = wire_r_u8(in);
      if (v < 2) js_set_bool(k, kl, v);
      break;
    }
    case WT_MODE: {
      const char *name = wire_mode_name(wire_r_u8(in));
      js_set_str(k, kl, (const uint8_t *)name, zlen(name));
      break;
    }
    case WT_U32: js_set_num(k, kl, wire_r_u32(in)); break;
    case WT_OPT: {
      uint32_t v = wire_r_u32(in);
      if (v != WIRE_NONE) js_set_num(k, kl, v);
      break;
    }
    case WT_I32: {
      int32_t v = (int32_t)wire_r_u32(in);
      if (v != WIRE_ABSENT) js_set_num(k, kl, v);
      break;
    }
    case WT_I64: js_set_num(k, kl, (double)wire_r_i64(in)); break;
    case WT_STR: {
      wire_str v = wire_r_str(in);
      js_set_str(k, kl, (const uint8_t *)v.p, v.len);
      break;
    }
    case WT_BYTES: {
      wire_str v = wire_r_str(in);
      js_set_bytes(k, kl, (const uint8_t *)v.p, v.len);
      break;
    }
    case WT_STRS: case WT_LIST: {
      uint32_t n = wire_r_u32(in); /* a count past the bytes stops at the first read past the end */
      js_set_list(k, kl);
      for (uint32_t j = 0; j < n && !in->bad; j++) {
        if (f->type == WT_STRS) {
          wire_str v = wire_r_str(in);
          js_push_str((const uint8_t *)v.p, v.len);
        } else {
          js_push_obj();
          decode_js(in, f->sub);
          js_leave();
        }
      }
      break;
    }
    }
  }
}
EXPORT("w_scratch") uint8_t *w_scratch(uint32_t n) {
  arena_reset();
  return arena(n ? n : 1);
}
/* The bytes the binding put at w_scratch's room: 1 read (the object is built), 0 bad bytes. */
EXPORT("w_decode") int w_decode(uint32_t kind, const uint8_t *p, uint32_t len) {
  wire_in in;
  if (kind >= WK_KINDS || !wire_open(&in, kind, p, len)) return 0;
  decode_js(&in, wire_schema_of(kind));
  return !in.bad && in.p == in.end;
}
EXPORT("w_kind_name") const char *w_kind_name(uint32_t kind) { return wire_kind_name(kind); }
EXPORT("w_bridge_protocol") uint32_t w_bridge_protocol(void) { return WIRE_BRIDGE_PROTOCOL; }
