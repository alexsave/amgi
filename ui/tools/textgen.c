/* textgen: the owner of the shipped UI strings' obfuscation (see ui/src/am_text.h).
 *
 * Usage: textgen <out-dir> <macros.h> <src1.c> <src2.c> ...
 *
 * It reads each source, finds every CD_LIT(...) and AM_Z(...) call, decodes the string the call
 * holds (adjacent string literals are joined, and an object-like string #define from <macros.h>,
 * e.g. AMGI_NOTETYPE_NAME, is substituted), and:
 *   - writes <out-dir>/<basename> with the call rewritten to am_s(id) (CD_LIT) or am_z(id) (AM_Z),
 *     the rest of the file byte for byte, and the same number of newlines inside the call so every
 *     later line keeps its number;
 *   - collects the unique decoded strings (first-seen order over the files as given) and, after all
 *     files, writes out/gen/am_blob_data.h (the XOR-obfuscated blob, the offsets, the key and the
 *     decode), am_blob.c (am_s/am_z over that data, interning and owning), and am_check.h (the
 *     plaintext, for the native roundtrip test only - never compiled into the module).
 *
 * The key is fixed (am_key below). No randomness, no time: the same sources give a byte-identical
 * blob, so the shipped wasm is reproducible. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- the obfuscation key: one fixed rolling byte, matched by am_blob_data.h's am_key ---- */
static unsigned char am_key(unsigned p) { return (unsigned char)(0xA5u ^ (p * 193u + 61u)); }

/* ---- a growable byte buffer ---- */
typedef struct { unsigned char *p; size_t n, cap; } buf;
static void bput(buf *b, const void *s, size_t n) {
  if (b->n + n > b->cap) {
    b->cap = (b->n + n) * 2 + 64;
    b->p = realloc(b->p, b->cap);
    if (!b->p) { perror("realloc"); exit(1); }
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
}
static void bputc(buf *b, unsigned char c) { bput(b, &c, 1); }
static void bputs(buf *b, const char *s) { bput(b, s, strlen(s)); }

/* ---- the unique-string pool ---- */
typedef struct { unsigned char *bytes; unsigned len; } str;
static str *pool;
static unsigned npool, cappool;
static unsigned intern_bytes(const unsigned char *bytes, unsigned len) {
  for (unsigned i = 0; i < npool; i++)
    if (pool[i].len == len && memcmp(pool[i].bytes, bytes, len) == 0) return i;
  if (npool == cappool) {
    cappool = cappool * 2 + 64;
    pool = realloc(pool, cappool * sizeof *pool);
    if (!pool) { perror("realloc"); exit(1); }
  }
  pool[npool].bytes = malloc(len ? len : 1);
  if (!pool[npool].bytes) { perror("malloc"); exit(1); }
  memcpy(pool[npool].bytes, bytes, len);
  pool[npool].len = len;
  return npool++;
}

/* ---- object-like string macros from the macros header (name -> decoded bytes) ---- */
typedef struct { char *name; unsigned char *bytes; unsigned len; } macro;
static macro *macros;
static unsigned nmacros;

static char *slurp(const char *path, size_t *outlen) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "textgen: cannot open %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *s = malloc((size_t)n + 1);
  if (!s) { perror("malloc"); exit(1); }
  if (fread(s, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "textgen: short read %s\n", path); exit(1); }
  s[n] = 0;
  fclose(f);
  if (outlen) *outlen = (size_t)n;
  return s;
}

/* Decode a C string literal body (between the quotes) into out, returning new length. Handles the
 * escapes amgi's strings use; a stray backslash is an error so nothing slips through unnoticed. */
static unsigned decode_lit(const char *s, unsigned n, buf *out) {
  unsigned start = (unsigned)out->n;
  for (unsigned i = 0; i < n; i++) {
    if (s[i] != '\\') { bputc(out, (unsigned char)s[i]); continue; }
    i++;
    if (i >= n) { fprintf(stderr, "textgen: trailing backslash in literal\n"); exit(1); }
    switch (s[i]) {
      case 'n': bputc(out, '\n'); break;
      case 't': bputc(out, '\t'); break;
      case 'r': bputc(out, '\r'); break;
      case '"': bputc(out, '"'); break;
      case '\\': bputc(out, '\\'); break;
      case '\'': bputc(out, '\''); break;
      case '0': bputc(out, '\0'); break;
      default: fprintf(stderr, "textgen: unsupported escape \\%c\n", s[i]); exit(1);
    }
  }
  return (unsigned)out->n - start;
}

static int is_ident(int c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; }

/* Scan the macros header for lines of the form: #define NAME "..."  (one or more adjacent literals). */
static void load_macros(const char *path) {
  size_t n;
  char *src = slurp(path, &n);
  char *p = src;
  while (*p) {
    char *nl = strchr(p, '\n');
    unsigned linelen = nl ? (unsigned)(nl - p) : (unsigned)strlen(p);
    /* match: optional ws, #define, ws, IDENT, ws, " */
    char *q = p;
    char *end = p + linelen;
    while (q < end && (*q == ' ' || *q == '\t')) q++;
    if (end - q > 7 && strncmp(q, "#define", 7) == 0) {
      q += 7;
      while (q < end && (*q == ' ' || *q == '\t')) q++;
      char *name = q;
      while (q < end && is_ident(*q)) q++;
      unsigned nl2 = (unsigned)(q - name);
      char *afterskip = q;
      while (afterskip < end && (*afterskip == ' ' || *afterskip == '\t')) afterskip++;
      if (nl2 && afterskip < end && *afterskip == '"') {
        /* collect adjacent string literals on this line */
        buf b = {0};
        char *r = afterskip;
        int ok = 1;
        while (r < end) {
          while (r < end && (*r == ' ' || *r == '\t')) r++;
          if (r >= end || *r != '"') break;
          char *ls = r + 1;
          char *le = ls;
          while (le < end && *le != '"') { if (*le == '\\') le++; le++; }
          if (le >= end) { ok = 0; break; }
          decode_lit(ls, (unsigned)(le - ls), &b);
          r = le + 1;
        }
        if (ok && b.n) {
          macros = realloc(macros, (nmacros + 1) * sizeof *macros);
          macros[nmacros].name = strndup(name, nl2);
          macros[nmacros].bytes = b.p;
          macros[nmacros].len = (unsigned)b.n;
          nmacros++;
        } else free(b.p);
      }
    }
    if (!nl) break;
    p = nl + 1;
  }
  free(src);
}

static const macro *find_macro(const char *name, unsigned len) {
  for (unsigned i = 0; i < nmacros; i++)
    if (strlen(macros[i].name) == len && strncmp(macros[i].name, name, len) == 0) return &macros[i];
  return 0;
}

/* Capture a CD_LIT(...)/AM_Z(...) argument starting at src[i] == '(' . Fills decoded bytes into out,
 * sets *consumed to the index just past the matching ')', and *newlines to the count inside the span
 * (from the '(' to the ')'). The argument is a run of string literals and macro identifiers. */
static void capture(const char *src, unsigned len, unsigned i, buf *out, unsigned *consumed, unsigned *newlines,
                    const char *file) {
  unsigned depth = 0;
  unsigned nl = 0;
  unsigned start = i;
  for (; i < len; i++) {
    char c = src[i];
    if (c == '\n') nl++;
    if (c == '"') {
      unsigned s = i + 1, e = s;
      while (e < len && src[e] != '"') { if (src[e] == '\\') e++; e++; }
      decode_lit(src + s, e - s, out);
      i = e;
      continue;
    }
    if (c == '(') { depth++; continue; }
    if (c == ')') { depth--; if (depth == 0) { i++; break; } continue; }
    if (is_ident((unsigned char)c) && !(c >= '0' && c <= '9')) {
      unsigned s = i, e = i;
      while (e < len && is_ident((unsigned char)src[e])) e++;
      const macro *m = find_macro(src + s, e - s);
      if (!m) {
        fprintf(stderr, "textgen: %s: unknown token '%.*s' inside a marked string\n", file, (int)(e - s), src + s);
        exit(1);
      }
      bput(out, m->bytes, m->len);
      i = e - 1;
      continue;
    }
    /* whitespace or stray punctuation between pieces: ignore */
  }
  *consumed = i;
  *newlines = nl;
  (void)start;
}

/* Rewrite one source file, recording its strings. */
static void rewrite_file(const char *inpath, const char *outdir) {
  size_t len;
  char *src = slurp(inpath, &len);
  const char *base = strrchr(inpath, '/');
  base = base ? base + 1 : inpath;

  buf out = {0};
  unsigned i = 0;
  while (i < len) {
    char c = src[i];
    /* comments: copy through, no marker detection inside */
    if (c == '/' && i + 1 < len && src[i + 1] == '/') {
      while (i < len && src[i] != '\n') bputc(&out, (unsigned char)src[i++]);
      continue;
    }
    if (c == '/' && i + 1 < len && src[i + 1] == '*') {
      bputc(&out, (unsigned char)src[i++]); bputc(&out, (unsigned char)src[i++]);
      while (i < len && !(src[i] == '*' && i + 1 < len && src[i + 1] == '/')) bputc(&out, (unsigned char)src[i++]);
      if (i < len) { bputc(&out, (unsigned char)src[i++]); bputc(&out, (unsigned char)src[i++]); }
      continue;
    }
    /* char literal: copy through */
    if (c == '\'') {
      bputc(&out, (unsigned char)src[i++]);
      while (i < len && src[i] != '\'') { if (src[i] == '\\') bputc(&out, (unsigned char)src[i++]); bputc(&out, (unsigned char)src[i++]); }
      if (i < len) bputc(&out, (unsigned char)src[i++]);
      continue;
    }
    /* string literal outside a marker: copy through */
    if (c == '"') {
      bputc(&out, (unsigned char)src[i++]);
      while (i < len && src[i] != '"') { if (src[i] == '\\') bputc(&out, (unsigned char)src[i++]); bputc(&out, (unsigned char)src[i++]); }
      if (i < len) bputc(&out, (unsigned char)src[i++]);
      continue;
    }
    /* a marker: CD_LIT or AM_Z as a whole token, then '(' */
    if ((c == 'C' || c == 'A') && (i == 0 || !is_ident((unsigned char)src[i - 1]))) {
      const char *kind = 0; unsigned klen = 0; int as_z = 0;
      if (len - i >= 6 && strncmp(src + i, "CD_LIT", 6) == 0 && !is_ident((unsigned char)src[i + 6])) { kind = "CD_LIT"; klen = 6; as_z = 0; }
      else if (len - i >= 4 && strncmp(src + i, "AM_Z", 4) == 0 && !is_ident((unsigned char)src[i + 4])) { kind = "AM_Z"; klen = 4; as_z = 1; }
      if (kind) {
        unsigned j = i + klen;
        while (j < len && (src[j] == ' ' || src[j] == '\t' || src[j] == '\n')) j++;
        if (j < len && src[j] == '(') {
          buf dec = {0};
          unsigned consumed, newlines;
          capture(src, (unsigned)len, j, &dec, &consumed, &newlines, base);
          unsigned id = intern_bytes(dec.p ? dec.p : (unsigned char *)"", (unsigned)dec.n);
          free(dec.p);
          char rep[32];
          snprintf(rep, sizeof rep, "%s(%u)", as_z ? "am_z" : "am_s", id);
          bputs(&out, rep);
          for (unsigned k = 0; k < newlines; k++) bputc(&out, '\n');
          i = consumed;
          continue;
        }
      }
    }
    bputc(&out, (unsigned char)src[i++]);
  }

  char outpath[1024];
  snprintf(outpath, sizeof outpath, "%s/%s", outdir, base);
  FILE *f = fopen(outpath, "wb");
  if (!f) { fprintf(stderr, "textgen: cannot write %s\n", outpath); exit(1); }
  fwrite(out.p, 1, out.n, f);
  fclose(f);
  free(out.p);
  free(src);
}

static void emit_blob(const char *outdir) {
  /* offsets and the concatenated blob */
  unsigned total = 0;
  for (unsigned i = 0; i < npool; i++) total += pool[i].len;
  unsigned char *blob = malloc(total ? total : 1);
  unsigned *off = malloc((npool + 1) * sizeof *off);
  unsigned pos = 0, maxlen = 1;
  for (unsigned i = 0; i < npool; i++) {
    off[i] = pos;
    for (unsigned j = 0; j < pool[i].len; j++) blob[pos + j] = (unsigned char)(pool[i].bytes[j] ^ am_key(pos + j));
    pos += pool[i].len;
    if (pool[i].len + 1 > maxlen) maxlen = pool[i].len + 1;
  }
  off[npool] = pos;

  char path[1024];
  /* am_blob_data.h: the data and the decode, shared by the module and the test. */
  snprintf(path, sizeof path, "%s/am_blob_data.h", outdir);
  FILE *f = fopen(path, "wb");
  if (!f) { perror("fopen"); exit(1); }
  fprintf(f, "/* Generated by ui/tools/textgen.c - do not edit. The obfuscated UI strings. */\n");
  fprintf(f, "#ifndef AMGI_AM_BLOB_DATA_H\n#define AMGI_AM_BLOB_DATA_H\n");
  fprintf(f, "#define AM_N %uu\n", npool);
  fprintf(f, "#define AM_MAXLEN %uu\n", maxlen);
  fprintf(f, "static const unsigned char AM_B[%u] = {", total ? total : 1);
  for (unsigned i = 0; i < total; i++) fprintf(f, "%s%u,", (i % 20) ? "" : "\n", blob[i]);
  if (!total) fprintf(f, "0");
  fprintf(f, "};\n");
  fprintf(f, "static const unsigned int AM_OFF[%u] = {", npool + 1);
  for (unsigned i = 0; i <= npool; i++) fprintf(f, "%s%u,", (i % 20) ? "" : "\n", off[i]);
  fprintf(f, "};\n");
  fprintf(f, "static inline unsigned char am_key(unsigned p) { return (unsigned char)(0xA5u ^ (p * 193u + 61u)); }\n");
  fprintf(f, "static inline unsigned am_decode(unsigned id, unsigned char *out) {\n");
  fprintf(f, "  unsigned o = AM_OFF[id], e = AM_OFF[id + 1], j = 0;\n");
  fprintf(f, "  for (unsigned p = o; p < e; p++) out[j++] = (unsigned char)(AM_B[p] ^ am_key(p));\n");
  fprintf(f, "  return e - o;\n}\n");
  fprintf(f, "#endif\n");
  fclose(f);

  /* am_blob.c: am_s/am_z over the data, interning and owning. */
  snprintf(path, sizeof path, "%s/am_blob.c", outdir);
  f = fopen(path, "wb");
  if (!f) { perror("fopen"); exit(1); }
  fprintf(f, "/* Generated by ui/tools/textgen.c - do not edit. */\n");
  fprintf(f, "#include \"app.h\"\n#include \"am_blob_data.h\"\n\n");
  fprintf(f, "static unsigned char am_buf[AM_MAXLEN];\n");
  fprintf(f, "static cd_str am_tab[AM_N ? AM_N : 1];\n");
  fprintf(f, "static const char *am_zcache[AM_N ? AM_N : 1];\n\n");
  fprintf(f, "cd_str am_s(unsigned id) {\n");
  fprintf(f, "  if (am_tab[id]) return am_tab[id];\n");
  fprintf(f, "  unsigned n = am_decode(id, am_buf);\n");
  fprintf(f, "  return am_tab[id] = cd_intern((const char *)am_buf, n);\n}\n\n");
  fprintf(f, "const char *am_z(unsigned id) {\n");
  fprintf(f, "  if (am_zcache[id]) return am_zcache[id];\n");
  fprintf(f, "  unsigned o = AM_OFF[id], e = AM_OFF[id + 1], n = e - o;\n");
  fprintf(f, "  char *b = (char *)cd_alloc(n + 1);\n");
  fprintf(f, "  for (unsigned p = o, j = 0; p < e; p++, j++) b[j] = (char)(AM_B[p] ^ am_key(p));\n");
  fprintf(f, "  b[n] = 0;\n  return am_zcache[id] = b;\n}\n");
  fclose(f);

  /* am_check.h: the plaintext, for the native roundtrip test only. */
  snprintf(path, sizeof path, "%s/am_check.h", outdir);
  f = fopen(path, "wb");
  if (!f) { perror("fopen"); exit(1); }
  fprintf(f, "/* Generated by ui/tools/textgen.c - do not edit. Plaintext for the roundtrip test. */\n");
  fprintf(f, "#ifndef AMGI_AM_CHECK_H\n#define AMGI_AM_CHECK_H\n");
  fprintf(f, "static const unsigned AM_PLAIN_LEN[%u] = {", npool ? npool : 1);
  for (unsigned i = 0; i < npool; i++) fprintf(f, "%s%u,", (i % 20) ? "" : "\n", pool[i].len);
  if (!npool) fprintf(f, "0");
  fprintf(f, "};\n");
  fprintf(f, "static const unsigned char AM_PLAIN[%u] = {", total ? total : 1);
  for (unsigned i = 0; i < npool; i++)
    for (unsigned j = 0; j < pool[i].len; j++) fprintf(f, "%u,", pool[i].bytes[j]);
  if (!total) fprintf(f, "0");
  fprintf(f, "};\n");
  fprintf(f, "#endif\n");
  fclose(f);

  free(blob); free(off);
}

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: textgen <out-dir> <macros.h> <src.c>...\n"); return 1; }
  const char *outdir = argv[1];
  load_macros(argv[2]);
  for (int a = 3; a < argc; a++) rewrite_file(argv[a], outdir);
  emit_blob(outdir);
  return 0;
}
