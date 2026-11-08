/* The C side of the collection core's differential test (test/parity/difftest.test.mjs): one case
 * per input line, "<op> <hex arg> [<hex arg> ...]", one answer per output line, hex, or "!" and
 * the hex of a thrown message. The Node side runs the JavaScript functions the C replaces over
 * the same generated corpus and compares every answer. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../collection/core.h"
#include "../collection/rng.h"

static int hv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : 0; }
static str unhex(arena *a, str t) {
  char *p = ar_alloc(a, t.n / 2 + 1);
  for (size_t i = 0; i + 1 < t.n; i += 2) p[i / 2] = (char)(hv(t.p[i]) * 16 + hv(t.p[i + 1]));
  return (str){p, t.n / 2};
}
static void hexout(buf *b, str s) {
  for (size_t i = 0; i < s.n; i++) buf_fmt(b, "%02x", (unsigned char)s.p[i]);
}

typedef struct { str op; str *args; size_t n; buf *out; } call;

static void body(cx *c, void *arg) {
  call *k = arg;
  str x = k->n > 0 ? k->args[0] : S(""), y = k->n > 1 ? k->args[1] : S("");
  buf r = {0};
  if (str_eq_c(k->op, "lower")) buf_s(&r, js_lower(c->a, x));
  else if (str_eq_c(k->op, "nfc")) buf_s(&r, js_nfc(c->a, x));
  else if (str_eq_c(k->op, "trim")) buf_s(&r, js_trim(x));
  else if (str_eq_c(k->op, "fold")) buf_s(&r, fold_key(c, x));
  else if (str_eq_c(k->op, "strip")) buf_s(&r, strip_html_preserving_media(c, x));
  else if (str_eq_c(k->op, "csum")) buf_fmt(&r, "%lld", (long long)field_checksum(c, strip_html_preserving_media(c, x)));
  else if (str_eq_c(k->op, "ankifield")) buf_s(&r, anki_fields(c, &x, 1)[0]);
  else if (str_eq_c(k->op, "roman")) buf_c(&r, looks_romanized(c, x, y) ? "1" : "0");
  else if (str_eq_c(k->op, "audio")) buf_s(&r, render_audio_reference(c, x));
  else if (str_eq_c(k->op, "components")) {
    size_t n;
    str *parts = human_name_to_components(c, x, &n);
    for (size_t i = 0; i < n; i++) {
      if (i) buf_ch(&r, '\x1e');
      buf_s(&r, parts[i]);
    }
  } else if (str_eq_c(k->op, "num")) {
    js_num(&r, strtod(str_z(c->a, x), NULL));
  } else if (str_eq_c(k->op, "json")) {
    const char *why = NULL;
    aj *v = anki_json_parse(c->a, x, &why);
    if (!v) cx_throw(c, NULL, 0, "SyntaxError");
    buf_s(&r, anki_json_stringify(c->a, v));
  } else if (str_eq_c(k->op, "cmp")) {
    buf_fmt(&r, "%d", js_cmp(x, y));
  } else if (str_eq_c(k->op, "locale")) {
    buf_fmt(&r, "%d", js_locale_cmp(x, y));
  } else if (str_eq_c(k->op, "extname")) {
    buf_s(&r, path_extname(x));
  } else if (str_eq_c(k->op, "basename")) {
    buf_s(&r, path_basename(c->a, x));
  } else if (str_eq_c(k->op, "join")) {
    buf_s(&r, path_join(c->a, x, y));
  } else if (str_eq_c(k->op, "renders")) {
    /* y: the non-empty names, separated by 0x1e */
    size_t n = 0;
    str names[64];
    size_t start = 0;
    for (size_t i = 0; i <= y.n && n < 64; i++)
      if (i == y.n || y.p[i] == '\x1e') {
        if (i > start) names[n++] = str_sub(y, start, i);
        start = i + 1;
      }
    buf_c(&r, template_renders_nonempty(c, x, names, n) ? "1" : "0");
  } else if (str_eq_c(k->op, "cloze")) {
    col_notetype nt = {0};
    nt.cloze = 1;
    int64_t *ords;
    size_t n = ordinals_for_new_note(c, &nt, k->args, k->n, 0, &ords);
    for (size_t i = 0; i < n; i++) buf_fmt(&r, "%s%lld", i ? "," : "", (long long)ords[i]);
  } else if (str_eq_c(k->op, "rng")) {
    rng g;
    rng_seed(&g, (uint32_t)strtoul(str_z(c->a, x), NULL, 10));
    for (int i = 0; i < 8; i++) buf_fmt(&r, "%s%u", i ? "," : "", rng_next(&g));
  } else {
    cx_throw(c, NULL, 0, "unknown op");
  }
  hexout(k->out, (str){r.p ? r.p : "", r.n});
  buf_free(&r);
}

int main(void) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, stdin)) > 0) {
    if (line[len - 1] == '\n') len--;
    arena a = {0};
    str l = {line, (size_t)len};
    str parts[16];
    size_t n = 0, start = 0;
    for (size_t i = 0; i <= l.n && n < 16; i++)
      if (i == l.n || l.p[i] == ' ') {
        parts[n++] = str_sub(l, start, i);
        start = i + 1;
      }
    str args[15];
    for (size_t i = 1; i < n; i++) args[i - 1] = unhex(&a, parts[i]);
    buf out = {0};
    call k = {parts[0], args, n - 1, &out};
    cx c = {&a, NULL, {0}};
    if (cx_try(&c, body, &k) < 0) {
      buf_free(&out);
      buf_ch(&out, '!');
      hexout(&out, c.err.message);
    }
    buf_ch(&out, '\n');
    fwrite(out.p, 1, out.n, stdout);
    buf_free(&out);
    ar_free(&a);
  }
  free(line);
  return 0;
}
