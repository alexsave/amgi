/* Rules about amgi's C that a program holds, beside the no-JSON and random scans.
 *
 * No thread cancellation: the collection core's per-path ticket lock (server/collection/direct.c)
 * is given back by every op, a throw included, but a cancelled thread would never give it back and
 * its path would wait for ever. So nothing in amgi's C, nor in the cbase it links, may call
 * pthread_cancel.
 *
 *   build/c_rules <repo root> <tracked .c and .h files, relative to the root...>
 *
 * The caller passes the tracked files (git ls-files); cbase/core and cbase/providers are walked here,
 * because the submodule's files are not in the superproject's index. Run by `make -C server
 * check-collection`. Exit status is 1 when any file calls pthread_cancel or the scan is blind. */
#include <ctype.h>
#include <dirent.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static const char *root;
static int checks, failures, saw_direct;

static int is_ident(int c) { return c == '_' || isalnum((unsigned char)c); }

/* \bpthread_cancel\s*\( */
static int calls_cancel(const char *s, size_t n) {
  const char *word = "pthread_cancel";
  size_t wl = strlen(word);
  for (size_t i = 0; i + wl <= n; i++) {
    if (memcmp(s + i, word, wl) != 0) continue;
    if (i > 0 && is_ident((unsigned char)s[i - 1])) continue;
    size_t j = i + wl;
    while (j < n && isspace((unsigned char)s[j])) j++;
    if (j < n && s[j] == '(') return 1;
  }
  return 0;
}

static void scan(const char *rel) {
  char path[PATH_MAX];
  size_t rl = strlen(rel);
  checks++;
  if (rl >= 19 && strcmp(rel + rl - 19, "collection/direct.c") == 0) saw_direct = 1;
  if (snprintf(path, sizeof path, "%s/%s", root, rel) >= (int)sizeof path) {
    failures++;
    fprintf(stderr, "FAIL %s: path too long\n", rel);
    return;
  }
  FILE *f = fopen(path, "rb");
  if (!f) {
    failures++;
    fprintf(stderr, "FAIL %s: cannot read it\n", rel);
    return;
  }
  size_t cap = 65536, n = 0;
  char *buf = malloc(cap);
  if (!buf) { fclose(f); fprintf(stderr, "out of memory\n"); exit(2); }
  size_t got;
  while ((got = fread(buf + n, 1, cap - n, f)) > 0) {
    n += got;
    if (n == cap) {
      cap *= 2;
      buf = realloc(buf, cap);
      if (!buf) { fclose(f); fprintf(stderr, "out of memory\n"); exit(2); }
    }
  }
  int bad = ferror(f);
  fclose(f);
  if (bad) {
    failures++;
    fprintf(stderr, "FAIL %s: read error\n", rel);
  } else if (calls_cancel(buf, n)) {
    failures++;
    fprintf(stderr, "FAIL %s: calls pthread_cancel (a cancelled thread never gives back the collection core's path lock)\n", rel);
  }
  free(buf);
}

/* Every .c and .h under root/rel, as rel paths. */
static void walk(const char *rel) {
  char dir[PATH_MAX];
  if (snprintf(dir, sizeof dir, "%s/%s", root, rel) >= (int)sizeof dir) return;
  DIR *d = opendir(dir);
  if (!d) return; /* a missing cbase directory is nothing to scan */
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char child[PATH_MAX], full[PATH_MAX];
    if (snprintf(child, sizeof child, "%s/%s", rel, e->d_name) >= (int)sizeof child) continue;
    if (snprintf(full, sizeof full, "%s/%s", root, child) >= (int)sizeof full) continue;
    struct stat st;
    if (stat(full, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) {
      walk(child);
    } else {
      size_t l = strlen(child);
      if ((l > 2 && strcmp(child + l - 2, ".c") == 0) || (l > 2 && strcmp(child + l - 2, ".h") == 0)) scan(child);
    }
  }
  closedir(d);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: c_rules <repo root> [tracked .c and .h files...]\n");
    return 2;
  }
  root = argv[1];
  for (int i = 2; i < argc; i++) scan(argv[i]);
  walk("cbase/core");
  walk("cbase/providers");
  checks++;
  if (!saw_direct) {
    failures++;
    fprintf(stderr, "FAIL the scan does not see the collection core (collection/direct.c)\n");
  }
  printf("c rules: %d files checked, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
