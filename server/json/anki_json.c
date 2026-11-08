/* Anki's JSON, as JSON.parse and JSON.stringify read and write it: see anki_json.h. */
#include "anki_json.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

aj *aj_null(arena *a) { return ar_alloc(a, sizeof(aj)); }
aj *aj_bool(arena *a, int b) {
  aj *v = ar_alloc(a, sizeof(aj));
  v->type = AJ_BOOL;
  v->b = !!b;
  return v;
}
aj *aj_num(arena *a, double x) {
  aj *v = ar_alloc(a, sizeof(aj));
  v->type = AJ_NUM;
  v->num = x;
  return v;
}
aj *aj_str(arena *a, str s) {
  aj *v = ar_alloc(a, sizeof(aj));
  v->type = AJ_STR;
  v->s = s;
  return v;
}
aj *aj_obj(arena *a) {
  aj *v = ar_alloc(a, sizeof(aj));
  v->type = AJ_OBJ;
  return v;
}
aj *aj_arr(arena *a) {
  aj *v = ar_alloc(a, sizeof(aj));
  v->type = AJ_ARR;
  return v;
}

void aj_push(arena *a, aj *arr, aj *v) {
  if (arr->n == arr->cap) {
    size_t cap = arr->cap ? arr->cap * 2 : 8;
    aj **items = ar_alloc(a, cap * sizeof *items);
    if (arr->n) memcpy(items, arr->items, arr->n * sizeof *items);
    arr->items = items;
    arr->cap = cap;
  }
  arr->items[arr->n++] = v;
}

aj *aj_get(const aj *obj, str key) {
  if (!obj || obj->type != AJ_OBJ) return NULL;
  for (size_t i = 0; i < obj->ne; i++)
    if (str_eq(obj->entries[i].key, key)) return obj->entries[i].value;
  return NULL;
}

void aj_set(arena *a, aj *obj, str key, aj *v) {
  for (size_t i = 0; i < obj->ne; i++)
    if (str_eq(obj->entries[i].key, key)) {
      obj->entries[i].value = v;
      return;
    }
  if (obj->ne == obj->ecap) {
    size_t cap = obj->ecap ? obj->ecap * 2 : 8;
    aj_entry *e = ar_alloc(a, cap * sizeof *e);
    if (obj->ne) memcpy(e, obj->entries, obj->ne * sizeof *e);
    obj->entries = e;
    obj->ecap = cap;
  }
  obj->entries[obj->ne++] = (aj_entry){key, v};
}

int aj_del(aj *obj, str key) {
  for (size_t i = 0; i < obj->ne; i++)
    if (str_eq(obj->entries[i].key, key)) {
      memmove(obj->entries + i, obj->entries + i + 1, (obj->ne - i - 1) * sizeof *obj->entries);
      obj->ne--;
      return 1;
    }
  return 0;
}

/* An array index, as JavaScript orders property keys: the canonical decimal form of 0..2^32-2. */
static int array_index(str k, uint64_t *v) {
  if (k.n == 0 || k.n > 10) return 0;
  if (k.n > 1 && k.p[0] == '0') return 0;
  uint64_t x = 0;
  for (size_t i = 0; i < k.n; i++) {
    if (k.p[i] < '0' || k.p[i] > '9') return 0;
    x = x * 10 + (uint64_t)(k.p[i] - '0');
  }
  if (x > 4294967294u) return 0;
  *v = x;
  return 1;
}

typedef struct { uint64_t index; size_t at; } keyed;
static int by_index(const void *x, const void *y) {
  const keyed *a = x, *b = y;
  return a->index < b->index ? -1 : a->index > b->index;
}

str *aj_keys(arena *a, const aj *obj, size_t *n) {
  *n = 0;
  if (!obj || obj->type != AJ_OBJ) return NULL;
  str *out = ar_alloc(a, (obj->ne + 1) * sizeof *out);
  keyed *ix = ar_alloc(a, (obj->ne + 1) * sizeof *ix);
  size_t ni = 0;
  for (size_t i = 0; i < obj->ne; i++) {
    uint64_t v;
    if (array_index(obj->entries[i].key, &v)) ix[ni++] = (keyed){v, i};
  }
  qsort(ix, ni, sizeof *ix, by_index);
  for (size_t i = 0; i < ni; i++) out[(*n)++] = obj->entries[ix[i].at].key;
  for (size_t i = 0; i < obj->ne; i++) {
    uint64_t v;
    if (!array_index(obj->entries[i].key, &v)) out[(*n)++] = obj->entries[i].key;
  }
  return out;
}

/* ---- JSON.parse ---- */
typedef struct { arena *a; str t; size_t at; const char *error; int depth; } parser;

static void ws(parser *p) {
  while (p->at < p->t.n) {
    char c = p->t.p[p->at];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    p->at++;
  }
}

static aj *fail(parser *p, const char *why) {
  if (!p->error) p->error = why;
  return NULL;
}

static int hex4(parser *p, uint32_t *out) {
  if (p->t.n - p->at < 4) return 0;
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) {
    char c = p->t.p[p->at + (size_t)i];
    int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
    if (d < 0) return 0;
    v = v * 16 + (uint32_t)d;
  }
  p->at += 4;
  *out = v;
  return 1;
}

/* A code point as WTF-8: a lone surrogate keeps its own three bytes, so it can be written back as
 * the \u escape it was read from. */
static void wtf8_put(buf *b, uint32_t cp) {
  if (cp >= 0xd800 && cp <= 0xdfff) {
    char t[3] = {(char)(0xe0 | cp >> 12), (char)(0x80 | ((cp >> 6) & 0x3f)), (char)(0x80 | (cp & 0x3f))};
    buf_put(b, t, 3);
  } else {
    utf8_put(b, cp);
  }
}

static int parse_string(parser *p, str *out) {
  p->at++; /* the opening quote */
  buf b = {0};
  for (;;) {
    if (p->at >= p->t.n) {
      buf_free(&b);
      fail(p, "Unterminated string in JSON");
      return 0;
    }
    unsigned char c = (unsigned char)p->t.p[p->at];
    if (c == '"') {
      p->at++;
      break;
    }
    if (c < 0x20) {
      buf_free(&b);
      fail(p, "Bad control character in string literal in JSON");
      return 0;
    }
    if (c != '\\') {
      buf_put(&b, &p->t.p[p->at], 1);
      p->at++;
      continue;
    }
    p->at++;
    if (p->at >= p->t.n) continue;
    char e = p->t.p[p->at++];
    uint32_t cp;
    switch (e) {
      case '"': buf_ch(&b, '"'); break;
      case '\\': buf_ch(&b, '\\'); break;
      case '/': buf_ch(&b, '/'); break;
      case 'b': buf_ch(&b, '\b'); break;
      case 'f': buf_ch(&b, '\f'); break;
      case 'n': buf_ch(&b, '\n'); break;
      case 'r': buf_ch(&b, '\r'); break;
      case 't': buf_ch(&b, '\t'); break;
      case 'u':
        if (!hex4(p, &cp)) {
          buf_free(&b);
          fail(p, "Bad Unicode escape in JSON");
          return 0;
        }
        if (cp >= 0xd800 && cp <= 0xdbff && p->t.n - p->at >= 6 && p->t.p[p->at] == '\\' && p->t.p[p->at + 1] == 'u') {
          size_t save = p->at;
          uint32_t lo;
          p->at += 2;
          if (hex4(p, &lo) && lo >= 0xdc00 && lo <= 0xdfff) cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          else p->at = save;
        }
        wtf8_put(&b, cp);
        break;
      default:
        buf_free(&b);
        fail(p, "Bad escaped character in JSON");
        return 0;
    }
  }
  *out = buf_str(p->a, &b);
  buf_free(&b);
  return 1;
}

static aj *parse_value(parser *p);

static aj *parse_number(parser *p) {
  size_t start = p->at;
  if (p->t.p[p->at] == '-') p->at++;
  if (p->at >= p->t.n) return fail(p, "No number after minus sign in JSON");
  if (p->t.p[p->at] == '0') {
    p->at++;
  } else if (p->t.p[p->at] >= '1' && p->t.p[p->at] <= '9') {
    while (p->at < p->t.n && p->t.p[p->at] >= '0' && p->t.p[p->at] <= '9') p->at++;
  } else {
    return fail(p, "No number after minus sign in JSON");
  }
  if (p->at < p->t.n && p->t.p[p->at] == '.') {
    p->at++;
    size_t d = p->at;
    while (p->at < p->t.n && p->t.p[p->at] >= '0' && p->t.p[p->at] <= '9') p->at++;
    if (p->at == d) return fail(p, "Unterminated fractional number in JSON");
  }
  if (p->at < p->t.n && (p->t.p[p->at] == 'e' || p->t.p[p->at] == 'E')) {
    p->at++;
    if (p->at < p->t.n && (p->t.p[p->at] == '+' || p->t.p[p->at] == '-')) p->at++;
    size_t d = p->at;
    while (p->at < p->t.n && p->t.p[p->at] >= '0' && p->t.p[p->at] <= '9') p->at++;
    if (p->at == d) return fail(p, "Exponent part is missing a number in JSON");
  }
  const char *z = ar_dup(p->a, p->t.p + start, p->at - start);
  return aj_num(p->a, strtod(z, NULL));
}

static int word(parser *p, const char *w) {
  size_t n = strlen(w);
  if (p->t.n - p->at < n || memcmp(p->t.p + p->at, w, n)) return 0;
  p->at += n;
  return 1;
}

static aj *parse_value(parser *p) {
  ws(p);
  if (p->at >= p->t.n) return fail(p, "Unexpected end of JSON input");
  /* Anki's own JSON nests a few levels; 256 keeps the recursion well inside a server thread's
   * stack (512 KiB by default on macOS), which unit.c checks on a 256 KiB one. */
  if (++p->depth > 256) return fail(p, "JSON nested too deeply");
  char c = p->t.p[p->at];
  aj *v = NULL;
  if (c == '{') {
    p->at++;
    v = aj_obj(p->a);
    ws(p);
    if (p->at < p->t.n && p->t.p[p->at] == '}') {
      p->at++;
    } else {
      for (;;) {
        ws(p);
        if (p->at >= p->t.n || p->t.p[p->at] != '"') return fail(p, "Expected property name in JSON");
        str key;
        if (!parse_string(p, &key)) return NULL;
        ws(p);
        if (p->at >= p->t.n || p->t.p[p->at] != ':') return fail(p, "Expected ':' after property name in JSON");
        p->at++;
        aj *item = parse_value(p);
        if (!item) return NULL;
        aj_set(p->a, v, key, item);
        ws(p);
        if (p->at < p->t.n && p->t.p[p->at] == ',') {
          p->at++;
          continue;
        }
        if (p->at < p->t.n && p->t.p[p->at] == '}') {
          p->at++;
          break;
        }
        return fail(p, "Expected ',' or '}' after property value in JSON");
      }
    }
  } else if (c == '[') {
    p->at++;
    v = aj_arr(p->a);
    ws(p);
    if (p->at < p->t.n && p->t.p[p->at] == ']') {
      p->at++;
    } else {
      for (;;) {
        aj *item = parse_value(p);
        if (!item) return NULL;
        aj_push(p->a, v, item);
        ws(p);
        if (p->at < p->t.n && p->t.p[p->at] == ',') {
          p->at++;
          continue;
        }
        if (p->at < p->t.n && p->t.p[p->at] == ']') {
          p->at++;
          break;
        }
        return fail(p, "Expected ',' or ']' after array element in JSON");
      }
    }
  } else if (c == '"') {
    str s;
    if (!parse_string(p, &s)) return NULL;
    v = aj_str(p->a, s);
  } else if (c == '-' || (c >= '0' && c <= '9')) {
    v = parse_number(p);
  } else if (word(p, "true")) {
    v = aj_bool(p->a, 1);
  } else if (word(p, "false")) {
    v = aj_bool(p->a, 0);
  } else if (word(p, "null")) {
    v = aj_null(p->a);
  } else {
    return fail(p, "Unexpected token in JSON");
  }
  p->depth--;
  return v;
}

aj *anki_json_parse(arena *a, str text, const char **error) {
  parser p = {a, text, 0, NULL, 0};
  aj *v = parse_value(&p);
  if (v) {
    ws(&p);
    if (p.at != text.n) v = fail(&p, "Unexpected non-whitespace character after JSON");
  }
  if (!v && error) *error = p.error ? p.error : "Unexpected end of JSON input";
  return v;
}

/* ---- JSON.stringify ---- */
static void quote(buf *b, str s) {
  static const char hexd[] = "0123456789abcdef";
  buf_ch(b, '"');
  for (size_t i = 0; i < s.n;) {
    unsigned char c = (unsigned char)s.p[i];
    /* A lone surrogate (WTF-8, ED A0..BF xx) goes back out as its escape. */
    if (c == 0xed && i + 2 < s.n && ((unsigned char)s.p[i + 1] & 0xe0) == 0xa0) {
      uint32_t cp = 0xd000 | (((unsigned char)s.p[i + 1] & 0x3fu) << 6) | ((unsigned char)s.p[i + 2] & 0x3fu);
      char e[7] = {'\\', 'u', hexd[cp >> 12], hexd[(cp >> 8) & 15], hexd[(cp >> 4) & 15], hexd[cp & 15], 0};
      buf_put(b, e, 6);
      i += 3;
      continue;
    }
    switch (c) {
      case '"': buf_c(b, "\\\""); break;
      case '\\': buf_c(b, "\\\\"); break;
      case '\b': buf_c(b, "\\b"); break;
      case '\f': buf_c(b, "\\f"); break;
      case '\n': buf_c(b, "\\n"); break;
      case '\r': buf_c(b, "\\r"); break;
      case '\t': buf_c(b, "\\t"); break;
      default:
        if (c < 0x20) {
          char e[7] = {'\\', 'u', '0', '0', hexd[c >> 4], hexd[c & 15], 0};
          buf_put(b, e, 6);
        } else {
          buf_put(b, &s.p[i], 1);
        }
    }
    i++;
  }
  buf_ch(b, '"');
}

static void write_value(arena *a, buf *b, const aj *v) {
  switch (v->type) {
    case AJ_NULL: buf_c(b, "null"); break;
    case AJ_BOOL: buf_c(b, v->b ? "true" : "false"); break;
    case AJ_NUM:
      if (!isfinite(v->num)) buf_c(b, "null");
      else js_num(b, v->num);
      break;
    case AJ_STR: quote(b, v->s); break;
    case AJ_ARR:
      buf_ch(b, '[');
      for (size_t i = 0; i < v->n; i++) {
        if (i) buf_ch(b, ',');
        write_value(a, b, v->items[i]);
      }
      buf_ch(b, ']');
      break;
    case AJ_OBJ: {
      size_t n;
      str *keys = aj_keys(a, v, &n);
      buf_ch(b, '{');
      for (size_t i = 0; i < n; i++) {
        if (i) buf_ch(b, ',');
        quote(b, keys[i]);
        buf_ch(b, ':');
        write_value(a, b, aj_get(v, keys[i]));
      }
      buf_ch(b, '}');
      break;
    }
  }
}

str anki_json_stringify(arena *a, const aj *v) {
  buf b = {0};
  write_value(a, &b, v);
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}
