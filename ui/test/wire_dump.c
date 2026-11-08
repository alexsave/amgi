/* Reads one wire answer on stdin and prints what the app's readers make of it, a field a line, or
 * "bad" when a reader refuses the bytes. ui/test/wire.test.mjs feeds it the server's encoders. */
#include <stdio.h>
#include "../wire/wire.h"

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) { (void)p; (void)len; (void)cap; return 0; }

static void str(const char *k, wire_str s) { printf("%s=%.*s\n", k, (int)s.len, s.p); }

int main(void) {
  static uint8_t buf[1 << 20];
  uint32_t len = (uint32_t)fread(buf, 1, sizeof buf, stdin);
  switch (wire_kind(buf, len)) {
  case WIRE_ERROR: {
    wire_error e;
    if (!wire_read_error(buf, len, &e)) break;
    printf("mode=%s\nretry=%u\nflags=%u\n", wire_mode_name(e.mode), e.retry_after_ms, e.flags);
    str("error", e.error);
    return 0;
  }
  case WIRE_STATUS: {
    wire_status s;
    if (!wire_read_status(buf, len, &s)) break;
    printf("mode=%s\nschema=%u\n", wire_mode_name(s.mode), s.schema_version);
    str("detail", s.detail);
    return 0;
  }
  case WIRE_DECKS: {
    wire_in in;
    wire_deck d;
    uint32_t mode, n;
    if (!wire_decks_check(buf, len) || !wire_decks_open(&in, buf, len, &mode, &n)) break;
    printf("mode=%s\nn=%u\n", wire_mode_name(mode), n);
    while (wire_decks_next(&in, &d)) {
      printf("id=%lld\ncount=%u\n", (long long)d.id, d.note_count);
      str("name", d.name);
    }
    return 0;
  }
  case WIRE_INSTALL: {
    wire_install s;
    if (!wire_read_install(buf, len, &s)) break;
    printf("installed=%u\nup_to_date=%u\nchecked=%u\nstale=%u\nready=%u\n", s.installed, s.up_to_date,
           s.collection_checked, s.stale_count, s.ready);
    return 0;
  }
  case WIRE_PROFILES: {
    wire_in in;
    wire_str base;
    wire_profile p;
    uint32_t exists, n, seen = 0;
    /* Read it all once to check it, then again to print it. */
    if (!wire_profiles_open(&in, buf, len, &base, &exists, &n)) break;
    while (wire_profiles_next(&in, &p)) seen++;
    if (seen != n || in.bad || in.p != in.end) break;
    wire_profiles_open(&in, buf, len, &base, &exists, &n);
    str("base", base);
    printf("exists=%u\nn=%u\n", exists, n);
    while (wire_profiles_next(&in, &p)) {
      str("name", p.name);
      str("path", p.collection_path);
    }
    return 0;
  }
  }
  printf("bad\n");
  return 1;
}
