/* Reads one wire message on stdin the way the app does (wire_room, wire_decode into the kind's
 * struct), prints the struct field by field through the schema, then writes the struct again with
 * the app's writer (wire_encode) and says whether the bytes came back the same. "bad" when the
 * reader refuses the bytes. ui/test/wire.test.mjs feeds it the server's encoder. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../wire/wire.h"

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) {
  (void)len;
  return realloc(p, cap);
}

static void print(const wire_schema *s, const uint8_t *in, const char *prefix) {
  for (uint32_t i = 0; i < s->n; i++) {
    const wire_field *f = &s->f[i];
    const uint8_t *at = in + f->off;
    printf("%s%s=", prefix, f->key);
    switch (f->type) {
    case WT_BOOL: case WT_TRI: printf("%u\n", *at); break;
    case WT_MODE: printf("%s\n", wire_mode_name(*(const uint32_t *)at)); break;
    case WT_U32: case WT_OPT: printf("%u\n", *(const uint32_t *)at); break;
    case WT_I32: printf("%d\n", *(const int32_t *)at); break;
    case WT_I64: {
      int64_t v;
      memcpy(&v, at, sizeof v);
      printf("%lld\n", (long long)v);
      break;
    }
    case WT_STR: {
      const wire_str *v = (const wire_str *)at;
      printf("%.*s\n", (int)v->len, v->p);
      break;
    }
    case WT_BYTES: {
      const wire_str *v = (const wire_str *)at;
      printf("0x");
      for (uint32_t k = 0; k < v->len; k++) printf("%02x", (unsigned char)v->p[k]);
      printf("\n");
      break;
    }
    case WT_STRS: {
      const wire_strs *v = (const wire_strs *)at;
      printf("[");
      for (uint32_t k = 0; k < v->n; k++) printf("%s%.*s", k ? "|" : "", (int)v->v[k].len, v->v[k].p);
      printf("]\n");
      break;
    }
    case WT_LIST: {
      const uint8_t *items = *(const uint8_t *const *)at;
      uint32_t n = *(const uint32_t *)(in + f->off_n);
      printf("%u\n", n);
      char sub[64];
      for (uint32_t k = 0; k < n; k++) {
        snprintf(sub, sizeof sub, "%s%s.%u.", prefix, f->key, k);
        print(f->sub, items + k * f->sub->size, sub);
      }
      break;
    }
    }
  }
}

int main(void) {
  static uint8_t buf[1 << 20];
  uint32_t len = (uint32_t)fread(buf, 1, sizeof buf, stdin);
  int32_t kind = wire_kind(buf, len);
  const wire_schema *s = kind >= 0 ? wire_schema_of((uint32_t)kind) : 0;
  uint32_t room = s ? wire_room((uint32_t)kind, buf, len) : WIRE_NONE;
  if (room == WIRE_NONE) {
    printf("bad\n");
    return 1;
  }
  void *out = calloc(1, s->size), *mem = malloc(room ? room : 1);
  wire_decode((uint32_t)kind, buf, len, out, mem);
  printf("kind=%s\n", wire_kind_name((uint32_t)kind));
  print(s, out, "");
  wire_buf b = {0, 0, 0};
  wire_encode(&b, (uint32_t)kind, out);
  printf("rewritten=%s\n", b.len == len && !memcmp(b.p, buf, len) ? "same" : "differ");
  free(b.p);
  free(out);
  free(mem);
  return 0;
}
