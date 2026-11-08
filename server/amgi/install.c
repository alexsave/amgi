/* Install in C: the port of what was src/server/anki/install.js and its route (Node, removed at L4).
 *
 * The file half is here: copying amgi's two add-ons and its card type into <Anki folder>/addons21,
 * written over the top and then pruned of what this build no longer ships (never deleted first, so
 * a running Anki never sees a missing folder), and the sha256 manifest that says whether an install
 * is current. The collection half (is the note type there and current; make it when Anki is closed)
 * goes through the transport's ops and the collection core. install.js's header says why the two
 * writers of the note type are split as they are. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "amgi.h"
#include "messages.h"

static const char *const SKIP_ENTRIES[] = {"__pycache__", "test", ".pytest_cache", ".DS_Store"};
static const char *const ADDONS[] = {"amgi_mic", "amgi_bridge"};
static const char *const CARD_TYPE_FILES[][2] = {
  {"anki/notetype/front.html", "front.html"},
  {"anki/notetype/back.html", "back.html"},
  {"anki/notetype/front-reverse.html", "front-reverse.html"},
  {"anki/notetype/back-reverse.html", "back-reverse.html"},
  {"anki/notetype/styling.css", "styling.css"},
  {"anki/media/_amgi-loop.js", "_amgi-loop.js"},
  {"anki/media/_amgi-loop.css", "_amgi-loop.css"},
};
static const char *const COLLECTION_MEDIA[] = {"_amgi-loop.js", "_amgi-loop.css"};
static const struct { const char *name, *front, *back; } COLLECTION_TEMPLATES[] = {
  {"Listening", "anki/notetype/front.html", "anki/notetype/back.html"},
  {"Listening reversed", "anki/notetype/front-reverse.html", "anki/notetype/back-reverse.html"},
};
/* The note type as the collection core's createNotetype takes it. Field and template order, the
 * names and the legacy requirements equal what anki/addon/amgi_bridge/notetype.py builds. */
static const char *const NOTETYPE_FIELDS[] = {"Cue", "CueAudio", "Target", "TargetAudio", "Language", "Notes"};

#define N(x) (sizeof(x) / sizeof *(x))

/* ---- file work, failing as Node's fs does: "<CODE>: <description>, <syscall> '<path>'" ---- */
typedef struct {
  arena *a;
  str error; /* set once something failed that Node would have thrown */
} fsx;

static const char *errno_code(int e) {
  switch (e) {
  case EACCES: return "EACCES";
  case EPERM: return "EPERM";
  case ENOENT: return "ENOENT";
  case EEXIST: return "EEXIST";
  case ENOTDIR: return "ENOTDIR";
  case EISDIR: return "EISDIR";
  case ENOSPC: return "ENOSPC";
  case EROFS: return "EROFS";
  case EMFILE: return "EMFILE";
  default: return "EIO";
  }
}
static const char *errno_text(int e) {
  switch (e) {
  case EACCES: return "permission denied";
  case EPERM: return "operation not permitted";
  case ENOENT: return "no such file or directory";
  case EEXIST: return "file already exists";
  case ENOTDIR: return "not a directory";
  case EISDIR: return "illegal operation on a directory";
  case ENOSPC: return "no space left on device";
  case EROFS: return "read-only file system";
  case EMFILE: return "too many open files";
  default: return "i/o error";
  }
}
static void fs_fail(fsx *f, const char *syscall, str path) {
  int e = errno;
  if (!f->error.p)
    f->error = str_c(ar_fmt(f->a, "%s: %s, %s '%.*s'", errno_code(e), errno_text(e), syscall, (int)path.n, path.p));
}

static int exists(arena *a, str path) {
  struct stat sb;
  return stat(str_z(a, path), &sb) == 0;
}
static int skipped(const char *name) {
  for (size_t i = 0; i < N(SKIP_ENTRIES); i++)
    if (!strcmp(name, SKIP_ENTRIES[i])) return 1;
  return 0;
}

/* fs.mkdirSync(path, {recursive: true}) */
static void mkdir_p(fsx *f, str path) {
  const char *p = str_z(f->a, path);
  struct stat sb;
  if (stat(p, &sb) == 0) {
    if (!S_ISDIR(sb.st_mode)) errno = EEXIST, fs_fail(f, "mkdir", path);
    return;
  }
  str parent = path_dirname(f->a, path);
  if (!str_eq(parent, path)) mkdir_p(f, parent);
  if (f->error.p) return;
  if (mkdir(p, 0777) != 0 && errno != EEXIST) fs_fail(f, "mkdir", path);
}

static int read_all(arena *a, str path, str *out) {
  int fd = open(str_z(a, path), O_RDONLY);
  if (fd < 0) return -1;
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
  *out = buf_str(a, &b);
  buf_free(&b);
  return 0;
}

/* fs.copyFileSync */
static void copy_file(fsx *f, str from, str to) {
  str data;
  if (read_all(f->a, from, &data) != 0) return fs_fail(f, "copyfile", from);
  int fd = open(str_z(f->a, to), O_WRONLY | O_CREAT | O_TRUNC, 0666);
  if (fd < 0) return fs_fail(f, "copyfile", to);
  size_t at = 0;
  while (at < data.n) {
    ssize_t w = write(fd, data.p + at, data.n - at);
    if (w < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return fs_fail(f, "copyfile", to);
    }
    at += (size_t)w;
  }
  close(fd);
}

/* readdirSync withFileTypes: the entries' names and whether each is a directory or a file (a link is
 * neither, as a Dirent of one says), in the order the folder gives them. */
typedef struct { str name; int dir, file; } entry;
static entry *list_dir(arena *a, str dir, size_t *n, int *ok) {
  *n = 0;
  DIR *d = opendir(str_z(a, dir));
  *ok = d != NULL;
  if (!d) return NULL;
  size_t cap = 16;
  entry *out = ar_alloc(a, cap * sizeof *out);
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    if (*n == cap) {
      entry *more = ar_alloc(a, cap * 2 * sizeof *more);
      memcpy(more, out, cap * sizeof *out);
      out = more, cap *= 2;
    }
    int dir_t = e->d_type == DT_DIR, file_t = e->d_type == DT_REG;
    if (e->d_type == DT_UNKNOWN) {
      struct stat sb;
      str full = path_join(a, dir, str_c(e->d_name));
      if (lstat(str_z(a, full), &sb) == 0) dir_t = S_ISDIR(sb.st_mode), file_t = S_ISREG(sb.st_mode);
    }
    out[(*n)++] = (entry){str_c(ar_dup(a, e->d_name, strlen(e->d_name))), dir_t, file_t};
  }
  closedir(d);
  return out;
}

static void copy_tree(fsx *f, str from, str to) {
  mkdir_p(f, to);
  if (f->error.p) return;
  size_t n;
  int ok;
  entry *e = list_dir(f->a, from, &n, &ok);
  if (!ok) return fs_fail(f, "scandir", from);
  for (size_t i = 0; i < n && !f->error.p; i++) {
    if (skipped(str_z(f->a, e[i].name))) continue;
    str src = path_join(f->a, from, e[i].name), dest = path_join(f->a, to, e[i].name);
    if (e[i].dir) copy_tree(f, src, dest);
    else if (e[i].file) copy_file(f, src, dest);
  }
}

/* fileList: every file in a tree, relative to it, without the skipped entries. */
typedef struct { str *v; size_t n, cap; } strlist;
static void push(arena *a, strlist *l, str s) {
  if (l->n == l->cap) {
    size_t cap = l->cap ? l->cap * 2 : 16;
    str *more = ar_alloc(a, cap * sizeof *more);
    if (l->n) memcpy(more, l->v, l->n * sizeof *more);
    l->v = more, l->cap = cap;
  }
  l->v[l->n++] = s;
}
static void file_list(arena *a, str dir, str prefix, strlist *out) {
  if (!exists(a, dir)) return;
  size_t n;
  int ok;
  entry *e = list_dir(a, dir, &n, &ok);
  for (size_t i = 0; i < n; i++) {
    if (skipped(str_z(a, e[i].name))) continue;
    str rel = prefix.n ? str_cat3(a, prefix, S("/"), e[i].name) : e[i].name;
    if (e[i].dir) file_list(a, path_join(a, dir, e[i].name), rel, out);
    else if (e[i].file) push(a, out, rel);
  }
}

static str digest(arena *a, str path) {
  str data;
  if (read_all(a, path, &data) != 0) return S("");
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int len = 0;
  EVP_Digest(data.p, data.n, md, &len, EVP_sha256(), NULL);
  char *hex = ar_alloc(a, 2 * len + 1);
  for (unsigned i = 0; i < len; i++) snprintf(hex + 2 * i, 3, "%02x", md[i]);
  return (str){hex, 2 * len};
}

/* A manifest: install path -> sha256, as two parallel lists. */
typedef struct { strlist keys, hashes; } manifest;
static str lookup(const manifest *m, str key, int *found) {
  for (size_t i = 0; i < m->keys.n; i++)
    if (str_eq(m->keys.v[i], key)) return *found = 1, m->hashes.v[i];
  return *found = 0, S("");
}
static void put(arena *a, manifest *m, str key, str hash) {
  for (size_t i = 0; i < m->keys.n; i++)
    if (str_eq(m->keys.v[i], key)) {
      m->hashes.v[i] = hash;
      return;
    }
  push(a, &m->keys, key);
  push(a, &m->hashes, hash);
}

static int source_available(arena *a, str root) {
  for (size_t i = 0; i < N(ADDONS); i++)
    if (!exists(a, path_join(a, root, str_c(ar_fmt(a, "anki/addon/%s/__init__.py", ADDONS[i]))))) return 0;
  return 1;
}

static void addon_manifest(arena *a, str base, manifest *m) {
  for (size_t i = 0; i < N(ADDONS); i++) {
    str dir = path_join(a, base, str_c(ADDONS[i]));
    strlist files = {0};
    file_list(a, dir, S(""), &files);
    for (size_t k = 0; k < files.n; k++)
      put(a, m, str_c(ar_fmt(a, "%s/%.*s", ADDONS[i], (int)files.v[k].n, files.v[k].p)), digest(a, path_join(a, dir, files.v[k])));
  }
}

static int by_js(const void *x, const void *y) { return js_cmp(*(const str *)x, *(const str *)y); }

str amgi_base_dir(arena *a, str override) { return override.n ? override : col_default_base_dir(a); }

/* ---- collectionDrift ---- */
static str read_text(arena *a, str path, int *ok) {
  str t;
  *ok = read_all(a, path, &t) == 0;
  return *ok ? utf8_clean(a, t) : S("");
}

/* {checked, stale}: 1 when checked. */
static int collection_drift(arena *a, const amgi_ops *o, str root, strlist *stale);
int amgi_collection_drift(arena *a, const amgi_ops *o, str root, str **stale, size_t *n) {
  strlist l = {0};
  int checked = collection_drift(a, o, root, &l);
  *stale = l.v, *n = checked ? l.n : 0;
  return checked;
}
static int collection_drift(arena *a, const amgi_ops *o, str root, strlist *stale) {
  if (!o || !source_available(a, root)) return 0;
  col_notetype *nts;
  size_t n;
  col_err e = {0};
  if (ops_list_notetypes(a, o, &nts, &n, &e)) return 0;
  const col_notetype *nt = NULL;
  for (size_t i = 0; i < n && !nt; i++)
    if (str_eq_c(nts[i].name, AMGI_NOTETYPE_NAME)) nt = &nts[i];
  if (!nt) {
    push(a, stale, S("the note type itself"));
    return 1;
  }
  for (size_t t = 0; t < N(COLLECTION_TEMPLATES); t++) {
    const col_template *tpl = NULL;
    /* new Map(...): the last template of a name wins. */
    for (size_t k = 0; k < nt->ntemplates; k++)
      if (str_eq_c(nt->templates[k].name, COLLECTION_TEMPLATES[t].name)) tpl = &nt->templates[k];
    str label = str_c(ar_fmt(a, "%s card", COLLECTION_TEMPLATES[t].name));
    if (!tpl) {
      push(a, stale, label);
      continue;
    }
    int ok1, ok2;
    str front = read_text(a, path_join(a, root, str_c(COLLECTION_TEMPLATES[t].front)), &ok1);
    str back = read_text(a, path_join(a, root, str_c(COLLECTION_TEMPLATES[t].back)), &ok2);
    if (!ok1 || !ok2) return stale->n = 0, 0; /* a throw: not checked */
    if (!str_eq(tpl->question, front) || !str_eq(tpl->answer, back)) push(a, stale, label);
  }
  for (size_t m = 0; m < N(COLLECTION_MEDIA); m++) {
    str shipped;
    if (read_all(a, path_join(a, root, str_c(ar_fmt(a, "anki/media/%s", COLLECTION_MEDIA[m]))), &shipped) != 0)
      return stale->n = 0, 0;
    int found = 0;
    str have = {0};
    if (ops_read_media(a, o, str_c(COLLECTION_MEDIA[m]), &found, &have, &e)) return stale->n = 0, 0;
    if (!found || !str_eq(have, shipped)) push(a, stale, str_c(COLLECTION_MEDIA[m]));
  }
  return 1;
}

void amgi_install_get(arena *a, const amgi_settings *s, cb_http_res *res) {
  str root = amgi_root(a);
  str base = amgi_base_dir(a, s->base_dir_override);
  str addons = path_join(a, base, S("addons21"));
  int installed = 1;
  for (size_t i = 0; i < N(ADDONS); i++)
    if (!exists(a, path_join(a, addons, str_c(ar_fmt(a, "%s/__init__.py", ADDONS[i]))))) installed = 0;
  int comparable = 0;
  strlist stale_files = {0};
  if (installed && source_available(a, root)) {
    comparable = 1;
    manifest want = {0}, have = {0};
    addon_manifest(a, path_join(a, root, S("anki/addon")), &want);
    for (size_t i = 0; i < N(CARD_TYPE_FILES); i++)
      put(a, &want, str_c(ar_fmt(a, "amgi_bridge/cardtype/%s", CARD_TYPE_FILES[i][1])),
          digest(a, path_join(a, root, str_c(CARD_TYPE_FILES[i][0]))));
    addon_manifest(a, addons, &have);
    manifest *both[] = {&want, &have};
    strlist seen = {0};
    for (int w = 0; w < 2; w++)
      for (size_t k = 0; k < both[w]->keys.n; k++) {
        str key = both[w]->keys.v[k];
        int dup = 0;
        for (size_t j = 0; j < seen.n && !dup; j++) dup = str_eq(seen.v[j], key);
        if (dup) continue;
        push(a, &seen, key);
        int f1, f2;
        str h1 = lookup(&want, key, &f1), h2 = lookup(&have, key, &f2);
        if (f1 != f2 || !str_eq(h1, h2)) push(a, &stale_files, key);
      }
    if (stale_files.n) qsort(stale_files.v, stale_files.n, sizeof(str), by_js);
  }
  uint8_t up_to_date = comparable ? (stale_files.n == 0) : WIRE_UNKNOWN;

  col_settings cs = amgi_col_settings(s);
  col_transport t;
  col_err e = {0};
  if (col_resolve_transport(a, &cs, &t, &e) < 0) return amgi_send_text(res, 500, e.message);
  amgi_ops o = {&t, s->collection_path};
  strlist stale = {0};
  int checked = collection_drift(a, t.ops ? &o : NULL, root, &stale);
  if (!checked) stale.n = 0;
  wire_strs ws = {ar_alloc(a, (stale.n + 1) * sizeof(wire_str)), (uint32_t)stale.n};
  for (size_t i = 0; i < stale.n; i++) ws.v[i] = amgi_ws(stale.v[i]);
  wire_install_state w = {(uint8_t)installed, up_to_date, (uint8_t)checked, ws,
                          (uint8_t)(up_to_date == 1 && checked && stale.n == 0), amgi_ws(base)};
  amgi_send_wire(a, res, 200, WK_INSTALL_STATE, &w);
}

/* installNotetypeDirect: 1 when the note type is now there (made, or already was). */
static int install_notetype_why(arena *a, const amgi_ops *o, str root, col_notetype_made *made_out);
static int install_notetype(arena *a, const amgi_ops *o, str root) { return install_notetype_why(a, o, root, NULL); }
int amgi_install_notetype(arena *a, const amgi_ops *o, str root, col_notetype_made *made) {
  return install_notetype_why(a, o, root, made);
}
static int install_notetype_why(arena *a, const amgi_ops *o, str root, col_notetype_made *made_out) {
  if (!o || !ops_is_direct(o)) return 0; /* only the direct transport can write it */
  col_media media[N(COLLECTION_MEDIA)];
  for (size_t m = 0; m < N(COLLECTION_MEDIA); m++) {
    str data;
    if (read_all(a, path_join(a, root, str_c(ar_fmt(a, "anki/media/%s", COLLECTION_MEDIA[m]))), &data) != 0) return 0;
    media[m] = (col_media){str_c(COLLECTION_MEDIA[m]), data.p, data.n};
  }
  col_spec spec = {0};
  spec.name = S(AMGI_NOTETYPE_NAME);
  spec.fields = ar_alloc(a, N(NOTETYPE_FIELDS) * sizeof(str));
  for (size_t i = 0; i < N(NOTETYPE_FIELDS); i++) spec.fields[i] = str_c(NOTETYPE_FIELDS[i]);
  spec.nfields = N(NOTETYPE_FIELDS);
  spec.templates = ar_alloc(a, N(COLLECTION_TEMPLATES) * sizeof(col_spec_template));
  for (size_t t = 0; t < N(COLLECTION_TEMPLATES); t++) {
    int ok1, ok2;
    str front = read_text(a, path_join(a, root, str_c(COLLECTION_TEMPLATES[t].front)), &ok1);
    str back = read_text(a, path_join(a, root, str_c(COLLECTION_TEMPLATES[t].back)), &ok2);
    if (!ok1 || !ok2) return 0;
    spec.templates[t] = (col_spec_template){str_c(COLLECTION_TEMPLATES[t].name), front, back};
  }
  spec.ntemplates = N(COLLECTION_TEMPLATES);
  int ok;
  spec.css = read_text(a, path_join(a, root, S("anki/notetype/styling.css")), &ok);
  if (!ok) return 0;
  /* Legacy "which fields must be non-empty": the forward card needs CueAudio (1), the reverse
   * TargetAudio (3). */
  static int64_t req0[] = {1}, req1[] = {3};
  col_requirement reqs[] = {{0, S("any"), req0, 1}, {1, S("any"), req1, 1}};
  spec.reqs = reqs;
  spec.nreqs = 2;
  col_notetype_made made;
  col_err e = {0};
  if (col_create_notetype(a, o->path, &spec, media, N(media), &made, &e)) {
    if (made_out) *made_out = (col_notetype_made){0, 0, 0, str_c(e.kind ? e.kind : "error")};
    return 0;
  }
  if (made_out) *made_out = made;
  return made.created || str_eq_c(made.reason, "exists");
}

void amgi_install_post(arena *a, const amgi_settings *s, str body_override, cb_http_res *res) {
  str root = amgi_root(a);
  str trimmed = js_trim(body_override);
  str base = amgi_base_dir(a, trimmed.n ? trimmed : s->base_dir_override);
  if (!source_available(a, root)) return amgi_send_message(a, res, 409, S(NO_SOURCE_MESSAGE));
  if (!exists(a, base))
    return amgi_send_message(
      a, res, 409, str_c(ar_fmt(a, "No Anki data folder at %.*s. Install Anki and open it once, then try again.", (int)base.n, base.p)));
  fsx f = {a, {0}};
  str addons = path_join(a, base, S("addons21"));
  mkdir_p(&f, addons);
  for (size_t i = 0; i < N(ADDONS) && !f.error.p; i++) {
    str target = path_join(a, addons, str_c(ADDONS[i]));
    str source = path_join(a, root, str_c(ar_fmt(a, "anki/addon/%s", ADDONS[i])));
    copy_tree(&f, source, target);
    if (f.error.p) break;
    strlist shipped = {0}, there = {0};
    file_list(a, source, S(""), &shipped);
    file_list(a, target, S(""), &there);
    for (size_t k = 0; k < there.n; k++) {
      int keep = 0;
      for (size_t j = 0; j < shipped.n && !keep; j++) keep = str_eq(shipped.v[j], there.v[k]);
      if (!keep) unlink(str_z(a, path_join(a, target, there.v[k]))); /* left for next time if it fails */
    }
  }
  if (!f.error.p) {
    str cardtype = path_join(a, addons, S("amgi_bridge/cardtype"));
    mkdir_p(&f, cardtype);
    for (size_t i = 0; i < N(CARD_TYPE_FILES) && !f.error.p; i++)
      copy_file(&f, path_join(a, root, str_c(CARD_TYPE_FILES[i][0])), path_join(a, cardtype, str_c(CARD_TYPE_FILES[i][1])));
  }
  if (f.error.p) return amgi_send_text(res, 500, f.error);

  /* Whichever transport is live right now, by the saved settings: only the direct one can write. */
  col_settings cs = amgi_col_settings(s);
  col_transport t;
  col_err e = {0};
  if (col_resolve_transport(a, &cs, &t, &e) < 0) return amgi_send_text(res, 500, e.message);
  amgi_ops o = {&t, s->collection_path};
  int ready = install_notetype(a, t.ops ? &o : NULL, root);
  wire_installed w = {1, (uint8_t)!ready, amgi_ws(ready ? S(INSTALLED_MESSAGE) : S(RESTART_MESSAGE)), amgi_ws(addons)};
  amgi_send_wire(a, res, 200, WK_INSTALLED, &w);
}
