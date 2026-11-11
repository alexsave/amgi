/* The source scans' shared part (ported from test/source-scan.mjs): which tracked files ship, and
 * their code with the comments blanked, so a scan reads code and not what a comment says about it.
 * Header only, so each scan program is one C file plus this.
 *
 * The rules are the JavaScript helper's: a file ships when its name ends in .js .mjs .cjs .ts .html
 * .py .c or .h, no path part is test, tests, __tests__, test-helpers, tools, scripts, docs, fixtures,
 * e2e, vendor or node_modules, and its last part is not *.test.* / *.spec.* / *.config.<lowercase>.
 * Comment blanking keeps the newlines and keeps strings (a "//" in a URL is not a comment). The caller
 * passes tracked paths (git ls-files), relative to the repository root. */
#ifndef SRCSCAN_H
#define SRCSCAN_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A whole file, NUL-terminated; NULL when it cannot be read. *n is its length. */
static inline char *read_file(const char *path, size_t *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  size_t cap = 65536, len = 0;
  char *buf = malloc(cap + 1);
  if (!buf) { fclose(f); return NULL; }
  size_t got;
  while ((got = fread(buf + len, 1, cap - len, f)) > 0) {
    len += got;
    if (len == cap) {
      cap *= 2;
      char *grown = realloc(buf, cap + 1);
      if (!grown) { free(buf); fclose(f); return NULL; }
      buf = grown;
    }
  }
  int bad = ferror(f);
  fclose(f);
  if (bad) { free(buf); return NULL; }
  buf[len] = 0;
  *n = len;
  return buf;
}

static inline int ends_with(const char *s, const char *suffix) {
  size_t sl = strlen(s), tl = strlen(suffix);
  return sl >= tl && strcmp(s + sl - tl, suffix) == 0;
}

/* /\.(?:js|mjs|cjs|ts|html|py|c|h)$/ */
static inline int is_source(const char *f) {
  static const char *exts[] = {".js", ".mjs", ".cjs", ".ts", ".html", ".py", ".c", ".h"};
  for (size_t i = 0; i < sizeof exts / sizeof *exts; i++)
    if (ends_with(f, exts[i])) return 1;
  return 0;
}

static inline int is_not_shipped_dir(const char *p, size_t len) {
  static const char *dirs[] = {"test", "tests", "__tests__", "test-helpers", "tools", "scripts", "docs",
                               "fixtures", "e2e", "vendor", "node_modules"};
  for (size_t i = 0; i < sizeof dirs / sizeof *dirs; i++)
    if (strlen(dirs[i]) == len && memcmp(dirs[i], p, len) == 0) return 1;
  return 0;
}

/* The last part matches /\.(?:test|spec|config)\.[a-z]+$/: its last dot is followed by one or more
 * lowercase letters to the end, and what precedes that dot ends in .test, .spec or .config. */
static inline int last_part_is_test_like(const char *part, size_t len) {
  const char *dot = NULL;
  for (size_t i = 0; i < len; i++) if (part[i] == '.') dot = part + i;
  if (!dot || dot == part + len - 1) return 0;
  for (const char *q = dot + 1; q < part + len; q++) if (*q < 'a' || *q > 'z') return 0;
  size_t before = (size_t)(dot - part);
  static const char *words[] = {".test", ".spec", ".config"};
  for (size_t i = 0; i < sizeof words / sizeof *words; i++) {
    size_t wl = strlen(words[i]);
    if (before >= wl && memcmp(part + before - wl, words[i], wl) == 0) return 1;
  }
  return 0;
}

static inline int not_shipped(const char *f) {
  const char *part = f;
  for (;;) {
    const char *slash = strchr(part, '/');
    size_t len = slash ? (size_t)(slash - part) : strlen(part);
    if (is_not_shipped_dir(part, len)) return 1;
    if (!slash) return last_part_is_test_like(part, len);
    part = slash + 1;
  }
}

static inline int shipped(const char *f) { return is_source(f) && !not_shipped(f); }

/* The code of a JavaScript-like file (C, JS, TS, HTML) with comments blanked, lines kept. */
static inline char *strip_js(const char *s, size_t n, size_t *on) {
  char *out = malloc(n + 1);
  size_t o = 0, i = 0;
  char quote = 0;
  if (!out) return NULL;
  while (i < n) {
    char c = s[i];
    char d = i + 1 < n ? s[i + 1] : '\0';
    if (quote) {
      out[o++] = c;
      if (c == '\\') { if (i + 1 < n) out[o++] = d; i += 2; continue; }
      if (c == quote || (c == '\n' && quote != '`')) quote = 0;
      i++;
    } else if (c == '"' || c == '\'' || c == '`') {
      quote = c; out[o++] = c; i++;
    } else if (c == '/' && d == '/') {
      while (i < n && s[i] != '\n') i++;
    } else if (c == '/' && d == '*') {
      i += 2;
      while (i < n && !(s[i] == '*' && i + 1 < n && s[i + 1] == '/')) { if (s[i] == '\n') out[o++] = '\n'; i++; }
      i += 2;
    } else {
      out[o++] = c; i++;
    }
  }
  out[o] = 0;
  *on = o;
  return out;
}

/* The code of a Python file with comments and triple-quoted strings blanked, lines kept. */
static inline char *strip_py(const char *s, size_t n, size_t *on) {
  char *out = malloc(n + 1);
  size_t o = 0, i = 0;
  int qlen = 0; /* 0: code, 1: in a single-quoted string, 3: in a triple-quoted one */
  char qch = 0;
  if (!out) return NULL;
  while (i < n) {
    char c = s[i];
    int triple = i + 3 <= n && (c == '"' || c == '\'') && s[i + 1] == c && s[i + 2] == c;
    if (qlen == 3) {
      if (triple && c == qch) { qlen = 0; i += 3; continue; }
      if (c == '\n') out[o++] = '\n';
      i++;
    } else if (qlen == 1) {
      out[o++] = c;
      if (c == '\\') { if (i + 1 < n) out[o++] = s[i + 1]; i += 2; continue; }
      if (c == qch || c == '\n') qlen = 0;
      i++;
    } else if (triple) {
      qlen = 3; qch = c; i += 3;
    } else if (c == '"' || c == '\'') {
      qlen = 1; qch = c; out[o++] = c; i++;
    } else if (c == '#') {
      while (i < n && s[i] != '\n') i++;
    } else {
      out[o++] = c; i++;
    }
  }
  out[o] = 0;
  *on = o;
  return out;
}

#endif
