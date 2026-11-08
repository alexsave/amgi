/* plusaudio/lib/collection/media.js and paths.js: the collection's media folder, and where a
 * user's Anki profiles are. Plain file work, as in Node: path.join's normalising and
 * fs.existsSync's following of links included. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core.h"

str media_dir_for(cx *c, str collection) {
  str base = collection;
  if (base.n >= 6 && !memcmp(base.p + base.n - 6, ".anki2", 6)) base.n -= 6;
  return str_cat(c->a, base, S(".media"));
}

static int exists(cx *c, str path) {
  struct stat sb;
  return stat(str_z(c->a, path), &sb) == 0;
}

static int mkdir_p(const char *path) {
  char tmp[4096];
  size_t n = strlen(path);
  if (n >= sizeof tmp) return -1;
  memcpy(tmp, path, n + 1);
  for (size_t i = 1; i <= n; i++)
    if (tmp[i] == '/' || tmp[i] == 0) {
      char was = tmp[i];
      tmp[i] = 0;
      if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
      tmp[i] = was;
    }
  return 0;
}

/* fs.readFileSync: 0, or -1 with errno (ENOENT, EISDIR, ...). */
static int read_file(cx *c, str path, str *out) {
  int fd = open(str_z(c->a, path), O_RDONLY);
  if (fd < 0) return -1;
  struct stat sb;
  if (fstat(fd, &sb) != 0 || S_ISDIR(sb.st_mode)) {
    close(fd);
    errno = EISDIR;
    return -1;
  }
  buf b = {0};
  char chunk[1 << 16];
  ssize_t r;
  while ((r = read(fd, chunk, sizeof chunk)) > 0) buf_put(&b, chunk, (size_t)r);
  int e = errno;
  close(fd);
  if (r < 0) {
    buf_free(&b);
    errno = e;
    return -1;
  }
  *out = buf_str(c->a, &b);
  buf_free(&b);
  return 0;
}

static void write_file(cx *c, str path, const void *data, size_t n) {
  int fd = open(str_z(c->a, path), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) cx_throw(c, NULL, 0, "%s, open '%.*s'", strerror(errno), (int)path.n, path.p);
  const char *p = data;
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      int e = errno;
      close(fd);
      cx_throw(c, NULL, 0, "%s, write", strerror(e));
    }
    p += w;
    n -= (size_t)w;
  }
  close(fd);
}

static void ensure_dir(cx *c, str dir) {
  if (mkdir_p(str_z(c->a, dir)) != 0) cx_throw(c, NULL, 0, "%s, mkdir '%.*s'", strerror(errno), (int)dir.n, dir.p);
}

/* normalizeFilename: the base name, NFC, no control characters; nothing, "." or ".." refused. */
static str normalize_filename(cx *c, str desired) {
  str base = js_nfc(c->a, path_basename(c->a, desired));
  buf b = {0};
  for (size_t at = 0; at < base.n;) {
    size_t from = at;
    uint32_t cp = utf8_next(base, &at);
    if (cp > 0x1f && cp != 0x7f) buf_put(&b, base.p + from, at - from);
  }
  str clean = buf_str(c->a, &b);
  buf_free(&b);
  if (!clean.n || str_eq_c(clean, ".") || str_eq_c(clean, ".."))
    cx_throw(c, NULL, 0, "\"%.*s\" is not a usable media filename", (int)desired.n, desired.p);
  return clean;
}

str media_add(cx *c, str dir, str desired, const void *data, size_t len) {
  ensure_dir(c, dir);
  char sha[41];
  sha1_hex(data, len, sha);
  str filename = normalize_filename(c, desired);
  str lower = js_lower(c->a, filename);
  str candidates[2] = {filename, lower};
  for (int i = 0; i < 2; i++) {
    str path = path_join(c->a, dir, candidates[i]);
    str existing;
    if (read_file(c, path, &existing) != 0) {
      if (errno != ENOENT) cx_throw(c, NULL, 0, "%s, open '%.*s'", strerror(errno), (int)path.n, path.p);
      write_file(c, path, data, len);
      return candidates[i];
    }
    char theirs[41];
    sha1_hex(existing.p, existing.n, theirs);
    if (!strcmp(theirs, sha)) return candidates[i];
  }
  /* addHashSuffix(filename.toLowerCase(), sha1) */
  str ext = path_extname(lower);
  str stem = str_sub(lower, 0, lower.n - ext.n);
  str named = str_c(ar_fmt(c->a, "%.*s-%s%.*s", (int)stem.n, stem.p, sha, (int)ext.n, ext.p));
  write_file(c, path_join(c->a, dir, named), data, len);
  return named;
}

/* writeFixedNameMedia: a file other files load by its name, replaced when its bytes differ. */
int media_write_fixed(cx *c, str dir, str name, const void *data, size_t len) {
  str base = path_basename(c->a, name);
  if (!str_eq(name, base) || str_eq_c(name, ".") || str_eq_c(name, ".."))
    cx_throw(c, NULL, 0, "refusing to write media outside the media folder: %.*s", (int)name.n, name.p);
  ensure_dir(c, dir);
  str full = path_join(c->a, dir, name);
  str existing;
  if (read_file(c, full, &existing) == 0) {
    if (existing.n == len && (len == 0 || !memcmp(existing.p, data, len))) return 0;
  } else if (errno != ENOENT) {
    cx_throw(c, NULL, 0, "%s, open '%.*s'", strerror(errno), (int)full.n, full.p);
  }
  write_file(c, full, data, len);
  return 1;
}

int media_exists(cx *c, str dir, str name) { return exists(c, path_join(c->a, dir, name)); }

/* readMediaFile: a hostile name (a separator, a parent, a NUL) is refused, not resolved. */
int media_read(cx *c, str dir, str name, str *out) {
  if (!name.n) return 0;
  if (memchr(name.p, '/', name.n) || memchr(name.p, '\\', name.n) || memchr(name.p, 0, name.n)) return 0;
  if (str_eq_c(name, ".") || str_eq_c(name, "..")) return 0;
  str full = path_join(c->a, dir, name);
  if (!exists(c, full)) return 0;
  return read_file(c, full, out) == 0;
}

/* ---- paths.js ---- */
str col_default_base_dir(arena *a) {
  const char *home = getenv("HOME");
  str h = str_c(home ? home : "");
#ifdef __APPLE__
  return path_join(a, path_join(a, path_join(a, h, S("Library")), S("Application Support")), S("Anki2"));
#else
  const char *xdg = getenv("XDG_DATA_HOME");
  str base = xdg && *xdg ? str_c(xdg) : path_join(a, path_join(a, h, S(".local")), S("share"));
  return path_join(a, base, S("Anki2"));
#endif
}

static int by_locale(const void *x, const void *y) {
  const col_profile *a = x, *b = y;
  return js_locale_cmp(a->name, b->name);
}

col_profile *col_list_profiles(arena *a, str base_dir, size_t *n) {
  *n = 0;
  DIR *d = opendir(str_z(a, base_dir));
  if (!d) return NULL;
  size_t cap = 8;
  col_profile *out = ar_alloc(a, cap * sizeof *out);
  struct dirent *e;
  while ((e = readdir(d))) {
    if (e->d_type != DT_DIR || !strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    str name = str_c(ar_dup(a, e->d_name, strlen(e->d_name)));
    str path = path_join(a, path_join(a, base_dir, name), S("collection.anki2"));
    struct stat sb;
    if (stat(str_z(a, path), &sb) != 0) continue;
    if (*n == cap) {
      col_profile *more = ar_alloc(a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more;
      cap *= 2;
    }
    out[(*n)++] = (col_profile){name, path};
  }
  closedir(d);
  qsort(out, *n, sizeof *out, by_locale);
  return out;
}
