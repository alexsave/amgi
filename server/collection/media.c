/* plusaudio/lib/collection/media.js and paths.js: the collection's media folder, and where a
 * user's Anki profiles are. Plain file work, as in Node: path.join's normalising and
 * fs.existsSync's following of links included. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif

#include "core.h"

str media_dir_for(cx *c, str collection) {
  str base = collection;
  if (base.n >= 6 && !memcmp(base.p + base.n - 6, ".anki2", 6)) base.n -= 6;
  return str_cat(c->a, base, S(".media"));
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

/* The most a media file may be read at: a clip is well under a megabyte, and a file past this is
 * not one amgi wrote. */
#define MEDIA_READ_MAX (256u << 20)

/* ---- what is a media file: the one rule hasMedia, readMedia and col_media_path share ---- */

/* A name that is not a media file's: a separator, a NUL, ".", ".." or nothing, so nothing here
 * probes or reads outside the folder. */
static int hostile_name(str name) {
  return !name.n || memchr(name.p, '/', name.n) || memchr(name.p, '\\', name.n) || memchr(name.p, 0, name.n) ||
         str_eq_c(name, ".") || str_eq_c(name, "..");
}

/* A regular file (not a directory, FIFO or device) of at most MEDIA_READ_MAX. */
static int media_kind(const struct stat *sb) { return S_ISREG(sb->st_mode) && sb->st_size <= (off_t)MEDIA_READ_MAX; }

/* The path of media file `name` in dir when there is one: not a symlink (lstat, as read_file's
 * O_NOFOLLOW), and media_kind. */
static int vetted(cx *c, str dir, str name, str *full) {
  if (hostile_name(name)) return 0;
  *full = path_join(c->a, dir, name);
  struct stat sb;
  return lstat(str_z(c->a, *full), &sb) == 0 && media_kind(&sb);
}

/* fs.readFileSync, hardened: 0, or -1 with errno. A symlink is not followed (ELOOP), so a link in
 * the media folder cannot read a file outside it; only a regular file is read (EISDIR for a
 * directory, EINVAL for a FIFO or a device, which the non-blocking open keeps from hanging); and
 * nothing past MEDIA_READ_MAX is read (EFBIG). media_kind is checked again on the open descriptor,
 * so a file swapped after vetted is still held to the rule. */
static int read_file(cx *c, str path, str *out) {
  int fd = open(str_z(c->a, path), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return -1;
  struct stat sb;
  if (fstat(fd, &sb) != 0 || !media_kind(&sb)) {
    int e = errno;
    if (fstat(fd, &sb) == 0) e = S_ISDIR(sb.st_mode) ? EISDIR : S_ISREG(sb.st_mode) ? EFBIG : EINVAL;
    close(fd);
    errno = e;
    return -1;
  }
  buf b = {0};
  char chunk[1 << 16];
  ssize_t r;
  while ((r = read(fd, chunk, sizeof chunk)) > 0) {
    if (b.n + (size_t)r > MEDIA_READ_MAX) {
      buf_free(&b);
      close(fd);
      errno = EFBIG;
      return -1;
    }
    buf_put(&b, chunk, (size_t)r);
  }
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

/* ---- writing: a temporary in the folder, synced, renamed into place ----
 *
 * A media file's name is its identity (addMedia takes an existing file of the same bytes as the
 * file), so a half-written file under its final name would stand for the clip for good. Every
 * write is therefore whole or absent: the bytes go to a hidden temporary in the same folder, every
 * short write is finished, the file is synced, and only then renamed to its name, and the folder is
 * synced so the rename itself survives a power cut. A failure removes the temporary; a killed
 * process leaves only a hidden one (".amgi-<pid>-<n>.tmp"), which Anki's media check skips as it
 * skips every name with a leading dot, and which no later write reuses. */

/* The fault seam: only server/test/media_unit.c's build defines MEDIA_FAULTS. media_fault_next is
 * taken (and cleared) by the next write, so each fault hits exactly one. APPEAR puts a file
 * ("appeared") at the final name just before the rename, as another process could. */
enum { MEDIA_FAULT_NONE, MEDIA_FAULT_SHORT, MEDIA_FAULT_WRITE, MEDIA_FAULT_FSYNC, MEDIA_FAULT_RENAME, MEDIA_FAULT_KILL, MEDIA_FAULT_APPEAR };
typedef struct { int kind; size_t after; } media_fault;
#ifdef MEDIA_FAULTS
media_fault media_fault_next;
static media_fault fault_take(void) {
  media_fault f = media_fault_next;
  media_fault_next = (media_fault){0};
  return f;
}
#else
static media_fault fault_take(void) { return (media_fault){0}; }
#endif

/* Every byte, through short writes and EINTR: 0, or -1 with errno. Under a fault: SHORT makes each
 * write(2) take at most `after` of the bytes asked (a short write, as a pipe or a full disk can
 * answer); WRITE fails with EIO, and KILL kills the process, once `after` bytes are written. */
static int write_all(int fd, const char *p, size_t n, media_fault f) {
  size_t done = 0;
  while (done < n) {
    size_t ask = n - done, take = ask;
    if (f.kind == MEDIA_FAULT_SHORT && take > f.after) take = f.after;
    if ((f.kind == MEDIA_FAULT_WRITE || f.kind == MEDIA_FAULT_KILL) && take > f.after - done) take = f.after - done;
    if (!take) {
      if (f.kind == MEDIA_FAULT_KILL) raise(SIGKILL);
      errno = EIO;
      return -1;
    }
    ssize_t w = write(fd, p + done, take);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) {
      if (w == 0) errno = EIO;
      return -1;
    }
    done += (size_t)w;
  }
  return 0;
}

/* To the disk itself: on macOS fsync leaves the bytes in the drive's cache, F_FULLFSYNC flushes it
 * (and where a file system refuses it, fsync is what there is). */
static int sync_fd(int fd) {
#ifdef F_FULLFSYNC
  if (fcntl(fd, F_FULLFSYNC) == 0) return 0;
#endif
  return fsync(fd);
}

/* The folder's own entry for a rename. A file system that cannot sync a directory (EINVAL,
 * ENOTSUP) has nothing more to give, and is not an error. */
static void sync_dir(cx *c, str dir) {
  int fd = open(str_z(c->a, dir), O_RDONLY | O_DIRECTORY);
  if (fd < 0) cx_throw(c, NULL, 0, "%s, open '%.*s'", strerror(errno), (int)dir.n, dir.p);
  int r = sync_fd(fd), e = errno;
  close(fd);
  if (r != 0 && e != EINVAL && e != ENOTSUP && e != EOPNOTSUPP)
    cx_throw(c, NULL, 0, "%s, fsync '%.*s'", strerror(e), (int)dir.n, dir.p);
}

/* Rename `from` to `to` only when `to` does not exist: 0, or -1 with errno (EEXIST when it does).
 * The kernel's no-replace rename where the file system has it, else a hard link (which fails on
 * an existing name just the same) and the temporary's removal; on a file system with neither, a
 * check and a plain rename, which is no worse than the write it replaced. */
static int rename_new(const char *from, const char *to) {
  int r = -1;
#if defined(__APPLE__)
  r = renamex_np(from, to, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  r = (int)syscall(SYS_renameat2, AT_FDCWD, from, AT_FDCWD, to, 1 /* RENAME_NOREPLACE */);
#else
  errno = ENOTSUP;
#endif
  if (r == 0 || (errno != ENOTSUP && errno != EOPNOTSUPP && errno != EINVAL && errno != ENOSYS)) return r;
  if (link(from, to) == 0) {
    unlink(from);
    return 0;
  }
  if (errno != EPERM && errno != ENOTSUP && errno != EOPNOTSUPP && errno != EXDEV) return -1;
  struct stat sb;
  if (lstat(to, &sb) == 0) {
    errno = EEXIST;
    return -1;
  }
  return rename(from, to);
}

/* One temporary name per write in this process, never reused: the pid and a counter. A name left
 * by an earlier process with the same pid is skipped (O_EXCL). No randomness. */
static atomic_ulong temp_seq;

/* The bytes at `path` in dir, whole: 1; or, with replace 0 and a file already at path, 0 and
 * nothing written. Throws on failure, with the temporary removed. */
static int write_file(cx *c, str dir, str path, const void *data, size_t n, int replace) {
  media_fault f = fault_take();
  const char *tmp = NULL;
  int fd = -1;
  for (int tries = 0; fd < 0; tries++) {
    unsigned long seq = atomic_fetch_add(&temp_seq, 1);
    str name = str_c(ar_fmt(c->a, ".amgi-%ld-%lu.tmp", (long)getpid(), seq));
    tmp = str_z(c->a, path_join(c->a, dir, name));
    fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644);
    if (fd < 0 && (errno != EEXIST || tries == 100)) cx_throw(c, NULL, 0, "%s, open '%s'", strerror(errno), tmp);
  }
  const char *what = "write";
  int r = write_all(fd, data, n, f);
  if (r == 0) {
    what = "fsync";
    r = f.kind == MEDIA_FAULT_FSYNC ? (errno = EIO, -1) : sync_fd(fd);
  }
  int e = errno;
  if (close(fd) != 0 && r == 0) {
    what = "close";
    r = -1;
    e = errno;
  }
  const char *to = str_z(c->a, path);
  if (r == 0) {
    what = "rename";
    if (f.kind == MEDIA_FAULT_APPEAR) {
      int other = open(to, O_WRONLY | O_CREAT | O_EXCL, 0644);
      if (other >= 0) {
        if (write(other, "appeared", 8) != 8) abort();
        close(other);
      }
    }
    if (f.kind == MEDIA_FAULT_RENAME) r = (errno = EIO, -1);
    else r = replace ? rename(tmp, to) : rename_new(tmp, to);
    e = errno;
  }
  if (r != 0) {
    unlink(tmp);
    if (!replace && !strcmp(what, "rename") && e == EEXIST) return 0;
    cx_throw(c, NULL, 0, "%s, %s '%.*s'", strerror(e), what, (int)path.n, path.p);
  }
  sync_dir(c, dir);
  return 1;
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

/* addMedia's choice, once: the name the bytes are stored under, or an empty str when a file
 * appeared at the free candidate between the look and the write (another process's), for
 * media_add to look again. */
static str add_once(cx *c, str dir, str filename, str lower, const char sha[41], const void *data, size_t len) {
  str candidates[2] = {filename, lower};
  for (int i = 0; i < 2; i++) {
    str path = path_join(c->a, dir, candidates[i]);
    str existing;
    if (read_file(c, path, &existing) != 0) {
      if (errno != ENOENT) cx_throw(c, NULL, 0, "%s, open '%.*s'", strerror(errno), (int)path.n, path.p);
      return write_file(c, dir, path, data, len, 0) ? candidates[i] : (str){0};
    }
    char theirs[41];
    sha1_hex(existing.p, existing.n, theirs);
    if (!strcmp(theirs, sha)) return candidates[i];
  }
  /* addHashSuffix(filename.toLowerCase(), sha1): the name says the bytes, so it is replaced. */
  str ext = path_extname(lower);
  str stem = str_sub(lower, 0, lower.n - ext.n);
  str named = str_c(ar_fmt(c->a, "%.*s-%s%.*s", (int)stem.n, stem.p, sha, (int)ext.n, ext.p));
  write_file(c, dir, path_join(c->a, dir, named), data, len, 1);
  return named;
}

/* addMedia: the asked-for name when it is free or holds these bytes, else its lower-case form on
 * the same terms, else the lower-case name with the bytes' SHA-1. A new name is written without
 * replacing, so a file another process put there meanwhile is looked at again, never clobbered. */
str media_add(cx *c, str dir, str desired, const void *data, size_t len) {
  ensure_dir(c, dir);
  char sha[41];
  sha1_hex(data, len, sha);
  str filename = normalize_filename(c, desired);
  str lower = js_lower(c->a, filename);
  for (int tries = 0; tries < 8; tries++) {
    str stored = add_once(c, dir, filename, lower, sha, data, len);
    if (stored.n) return stored;
  }
  cx_throw(c, NULL, 0, "media file '%.*s' kept changing while it was added", (int)filename.n, filename.p);
}

/* writeFixedNameMedia: a file other files load by its name, replaced (whole, by rename) when its
 * bytes differ. */
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
  write_file(c, dir, full, data, len, 1);
  return 1;
}

/* hasMedia, readMediaFile and col_media_path: what vetted says is a media file, and nothing else
 * (so a symlinked clip is missing for all three). */
int media_exists(cx *c, str dir, str name) {
  str full;
  return vetted(c, dir, name, &full);
}

int media_read(cx *c, str dir, str name, str *out) {
  str full;
  return vetted(c, dir, name, &full) && read_file(c, full, out) == 0;
}

typedef struct { str path, name; int *found; str *file; } path_args;
static void path_fn(cx *c, void *arg) {
  path_args *p = arg;
  str full;
  *p->found = vetted(c, media_dir_for(c, p->path), p->name, &full);
  if (*p->found) *p->file = str_c(str_z(c->a, full));
}
/* collection.h: not behind the path lock, which a reader of a file only ever renamed into place
 * does not need. */
int col_media_path(arena *a, str path, str name, int *found, str *file, col_err *err) {
  *found = 0;
  *file = (str){0};
  cx c = {a, NULL, {0}};
  path_args p = {path, name, found, file};
  int r = cx_try(&c, path_fn, &p);
  if (r < 0 && err) *err = c.err;
  return r;
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
