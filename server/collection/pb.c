/* plusaudio/lib/protobuf.js: Anki's protobuf blobs (schema 18's notetype, field, template and deck
 * configs), read leniently and written as Anki's own encoder writes them. */
#include "core.h"

void pb_varint(buf *b, uint64_t v) {
  do {
    unsigned char byte = v & 0x7f;
    v >>= 7;
    if (v) byte |= 0x80;
    buf_put(b, &byte, 1);
  } while (v);
}

void pb_varint_field(buf *b, uint32_t field, uint64_t v) {
  pb_varint(b, (uint64_t)field * 8 + 0);
  pb_varint(b, v);
}

void pb_bytes_field(buf *b, uint32_t field, const void *p, size_t n) {
  pb_varint(b, (uint64_t)field * 8 + 2);
  pb_varint(b, n);
  buf_put(b, p, n);
}

/* readVarint: a double in the JavaScript, refused past 2^53; the same here. */
static uint64_t read_varint(cx *c, const unsigned char *p, size_t n, size_t *at) {
  double value = 0, scale = 1;
  for (size_t i = *at; i < n; i++) {
    value += (p[i] & 0x7f) * scale;
    if (!(p[i] & 0x80)) {
      if (value > 9007199254740991.0) cx_throw(c, NULL, 0, "protobuf varint is too large to read exactly");
      *at = i + 1;
      return (uint64_t)value;
    }
    scale *= 128;
  }
  cx_throw(c, NULL, 0, "truncated protobuf varint");
}

int pb_next(cx *c, const unsigned char *p, size_t n, size_t *at, uint64_t wanted, pb_field *f) {
  if (*at >= n) return 0;
  uint64_t tag = read_varint(c, p, n, at);
  f->number = (uint32_t)(tag / 8);
  f->wire = (uint32_t)(tag % 8);
  f->value = 0;
  f->bytes = NULL;
  f->len = 0;
  if (f->wire == 0) {
    if (f->number < 64 && (wanted >> f->number & 1)) {
      f->value = read_varint(c, p, n, at);
    } else {
      /* skipVarint: past it unread, whatever it holds. */
      while (*at < n && (p[*at] & 0x80)) (*at)++;
      (*at)++;
    }
  } else if (f->wire == 2) {
    uint64_t len = read_varint(c, p, n, at);
    if (len > n - *at) cx_throw(c, NULL, 0, "truncated protobuf field");
    f->bytes = p + *at;
    f->len = (size_t)len;
    *at += (size_t)len;
  } else if (f->wire == 1 || f->wire == 5) {
    size_t width = f->wire == 1 ? 8 : 4;
    if (*at + width > n) cx_throw(c, NULL, 0, "truncated protobuf field");
    f->bytes = p + *at;
    f->len = width;
    *at += width;
  } else {
    cx_throw(c, NULL, 0, "unsupported protobuf wire type %u", f->wire);
  }
  return 1;
}
