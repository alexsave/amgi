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

/* readVarint: refused past 2^53, as the JavaScript's double is. A varint is at most ten bytes;
 * a longer one is refused as too large (on a hostile blob the JavaScript's scale overflows to
 * infinity and the value to NaN, which it refuses the same way), so nothing here leaves a 64-bit
 * integer's range. */
static uint64_t read_varint(cx *c, const unsigned char *p, size_t n, size_t *at) {
  uint64_t value = 0;
  for (size_t i = *at, k = 0; i < n; i++, k++) {
    if (k == 10) cx_throw(c, NULL, 0, "protobuf varint is too large to read exactly");
    if (k < 9) value |= (uint64_t)(p[i] & 0x7f) << (7 * k);
    else if (p[i] & 0x7e) value = UINT64_MAX; /* past 64 bits: certainly too large */
    else value |= (uint64_t)(p[i] & 0x01) << 63;
    if (!(p[i] & 0x80)) {
      if (value > 9007199254740991ull) cx_throw(c, NULL, 0, "protobuf varint is too large to read exactly");
      *at = i + 1;
      return value;
    }
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
      /* skipVarint: past it unread, whatever it holds, and never past the end. */
      while (*at < n && (p[*at] & 0x80)) (*at)++;
      if (*at < n) (*at)++;
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
