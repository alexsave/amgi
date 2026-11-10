/* amgi: the one binary. `amgi serve` is the server (cbase's process ingress with the amgi app, exactly
 * what build/amgi-serve runs); every other word is the command line an agent or a person drives amgi
 * with, as a client of that server on loopback:
 *
 *   amgi up [--key-file PATH] [--port N] [--profile NAME]   start the server in the background
 *   amgi down                                               stop it
 *   amgi status                                             the collection's state and the install's
 *   amgi install                                            install the add-ons and the note type
 *   amgi deck add NAME | amgi deck list
 *   amgi card add --deck NAME (--front TEXT --back TEXT [--to LANG] | --text TEXT --from LANG --to LANG [--no-audio])
 *   amgi card list --deck NAME
 *
 * Every command is a call to the running server's routes (server/amgi/routes.c) in the wire format,
 * through cbase's loopback client, so the server's handlers stay the one owner of every rule: the
 * transport and its lock check, the backup before the first write, Gemini and its rate gate. The wire
 * stays inside: what is printed is plain text, one record a line, fields split by tabs, and a write
 * prints what reading it back finds.
 *
 * Exit codes: 0 done; 1 anything else (amgi not up, a server error); 2 Anki has the collection (locked);
 * 3 not found (a deck, the note type, a profile, the collection); 4 a usage error; 5 Gemini (no key,
 * rate limited, the daily cap, or it failed).
 *
 * `up` writes server/build/amgi.pid beside this binary (tab-separated lines: pid, port, profile,
 * collection), and the server's log to server/build/amgi.log. The Gemini key is only ever a path:
 * --key-file, or CBASE_ENV_FILE already in the environment, handed to the server as CBASE_ENV_FILE.
 * This program never opens that file. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach-o/dyld.h>
#endif

#include "../amgi/amgi.h"
#include "../amgi/messages.h"
#include "cbase/app.h"
#include "cbase/provider.h"
#include "ingress_process.h"
#include "net/https.h"
#include "util/err.h"

enum { RC_OK = 0, RC_FAIL = 1, RC_LOCKED = 2, RC_NOT_FOUND = 3, RC_USAGE = 4, RC_GEMINI = 5 };

#define LOCKED_LINE "locked: ask the user to close Anki"
#define NOT_UP_LINE "amgi is not up: run amgi up first"
#define NO_KEY_LINE \
  "gemini: no key, so nothing was generated: run amgi down, then amgi up --key-file PATH (a KEY=VALUE file with GEMINI_API_KEY)"
#define CALL_MS 120000       /* a write may back the collection up first */
#define GEN_MS 300000        /* a card: Gemini, and the rate gate's longest wait */
#define UP_WAIT_MS 20000     /* for the server to say it is listening */
#define DOWN_WAIT_MS 15000   /* for it to drain and exit */

static const char USAGE[] =
  "usage:\n"
  "  amgi up [--key-file PATH] [--port N] [--profile NAME]\n"
  "  amgi down\n"
  "  amgi status\n"
  "  amgi install\n"
  "  amgi deck add NAME\n"
  "  amgi deck list\n"
  "  amgi card add --deck NAME --front TEXT --back TEXT [--to LANG]\n"
  "  amgi card add --deck NAME --text TEXT --from LANG --to LANG [--no-audio]\n"
  "  amgi card list --deck NAME\n"
  "  amgi serve        (the server in the foreground; make start runs it)\n"
  "exit: 0 ok, 1 other failure, 2 locked (Anki open), 3 not found, 4 usage, 5 Gemini\n";

static int usage(const char *why) {
  if (why) fprintf(stderr, "amgi: %s\n", why);
  fputs(USAGE, stderr);
  return RC_USAGE;
}

/* ---- where things are: this binary's folder (server/build) and the repository above it ---- */
static char g_self[PATH_MAX], g_build[PATH_MAX], g_root[PATH_MAX], g_pidfile[PATH_MAX], g_log[PATH_MAX];

static int find_self(void) {
  char raw[PATH_MAX];
#ifdef __APPLE__
  uint32_t n = sizeof raw;
  if (_NSGetExecutablePath(raw, &n) != 0) return -1;
#else
  ssize_t n = readlink("/proc/self/exe", raw, sizeof raw - 1);
  if (n < 0) return -1;
  raw[n] = 0;
#endif
  if (!realpath(raw, g_self)) return -1;
  snprintf(g_build, sizeof g_build, "%s", g_self);
  char *slash = strrchr(g_build, '/');
  if (!slash) return -1;
  *slash = 0;
  /* server/build -> the repository root, where the server reads the page and the add-ons */
  char up[PATH_MAX];
  snprintf(up, sizeof up, "%s/../..", g_build);
  if (!realpath(up, g_root)) return -1;
  snprintf(g_pidfile, sizeof g_pidfile, "%s/amgi.pid", g_build);
  snprintf(g_log, sizeof g_log, "%s/amgi.log", g_build);
  return 0;
}

/* ---- the pid file: one "key<TAB>value" line each for pid, port, profile and collection ---- */
typedef struct {
  int pid, port;
  char profile[1024], collection[PATH_MAX];
} up_state;

/* 1 and *s, 0 when there is no pid file, -1 when it is not one this program wrote. */
static int read_state(up_state *s) {
  memset(s, 0, sizeof *s);
  FILE *f = fopen(g_pidfile, "r");
  if (!f) return errno == ENOENT ? 0 : -1;
  char line[PATH_MAX + 64];
  while (fgets(line, sizeof line, f)) {
    line[strcspn(line, "\n")] = 0;
    char *tab = strchr(line, '\t');
    if (!tab) continue;
    *tab = 0;
    const char *v = tab + 1;
    if (!strcmp(line, "pid")) s->pid = atoi(v);
    else if (!strcmp(line, "port")) s->port = atoi(v);
    else if (!strcmp(line, "profile")) snprintf(s->profile, sizeof s->profile, "%s", v);
    else if (!strcmp(line, "collection")) snprintf(s->collection, sizeof s->collection, "%s", v);
  }
  fclose(f);
  return s->pid > 0 && s->port > 0 && s->collection[0] ? 1 : -1;
}

static int write_state(const up_state *s) {
  char tmp[PATH_MAX + 8];
  snprintf(tmp, sizeof tmp, "%s.new", g_pidfile);
  FILE *f = fopen(tmp, "w");
  if (!f) return -1;
  fprintf(f, "pid\t%d\nport\t%d\nprofile\t%s\ncollection\t%s\n", s->pid, s->port, s->profile, s->collection);
  if (fclose(f) != 0) return -1;
  return rename(tmp, g_pidfile);
}

/* Whether pid is alive and is this very binary (so a pid reused by another program is never signalled). */
static int is_ours(int pid) {
  if (pid <= 0 || (kill(pid, 0) != 0 && errno != EPERM)) return 0;
  char exe[PATH_MAX], real[PATH_MAX];
#ifdef __APPLE__
  if (proc_pidpath(pid, exe, sizeof exe) <= 0) return 0;
#else
  char link[64];
  snprintf(link, sizeof link, "/proc/%d/exe", pid);
  ssize_t n = readlink(link, exe, sizeof exe - 1);
  if (n < 0) return 0;
  exe[n] = 0;
#endif
  return realpath(exe, real) && !strcmp(real, g_self);
}

static void sleep_ms(int ms) {
  struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L};
  nanosleep(&t, NULL);
}

/* ---- text out: one record a line, tab-separated, so a value never carries a tab or a line break ---- */
static void put(const char *p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char c = p[i];
    putchar(c == '\t' || c == '\n' || c == '\r' ? ' ' : c);
  }
}
static void put_w(wire_str w) { put(w.p ? w.p : "", w.len); }
static int weq(wire_str w, const char *s) { return w.len == strlen(s) && !memcmp(w.p, s, w.len); }

/* ---- calls to the server ---- */
static void enc_uri(buf *b, const char *s) { /* encodeURIComponent */
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || strchr("-_.!~*'()", *p))
      buf_ch(b, (char)*p);
    else buf_fmt(b, "%%%02X", *p);
  }
}

typedef struct {
  int status;
  uint8_t *p; /* the body, in the arena */
  uint32_t len;
} answer;

/* One request. 0 and *out, or RC_FAIL having said why (nothing answered on the port). */
static int call(arena *a, const up_state *s, const char *method, const char *path, int32_t send_kind, const void *send,
                int timeout_ms, answer *out) {
  buf h = {0};
  if (s->collection[0]) {
    buf_c(&h, "X-Amgi-Collection: ");
    enc_uri(&h, s->collection);
    buf_c(&h, "\r\nX-Amgi-Profile: ");
    enc_uri(&h, s->profile);
    buf_c(&h, "\r\n");
  }
  wire_buf body = {0, 0, 0};
  if (send_kind >= 0) {
    buf_c(&h, "Content-Type: " WIRE_MIME "\r\n");
    wire_encode(&body, (uint32_t)send_kind, send);
  }
  buf_ch(&h, 0);
  cb_https_response r = {0};
  int rc = cb_http_plain_request(CB_HTTPS_OTHER, "127.0.0.1", s->port, method, path, h.p, body.p, body.len, timeout_ms, &r);
  buf_free(&h);
  free(body.p);
  if (rc != CB_OK) {
    if (r.fail == CB_HTTPS_FAIL_CONNECT) fprintf(stderr, "%s (nothing answers on port %d)\n", NOT_UP_LINE, s->port);
    else fprintf(stderr, "amgi: %s %s: %s\n", method, path, r.why);
    cb_https_response_free(&r);
    return RC_FAIL;
  }
  out->status = r.status;
  out->len = (uint32_t)r.body.len;
  out->p = (uint8_t *)ar_dup(a, r.body.p ? (const char *)r.body.p : "", r.body.len);
  cb_https_response_free(&r);
  return 0;
}

/* The answer as a kind's struct, or NULL when it is not one whole message of that kind. */
static void *as_kind(arena *a, const answer *x, uint32_t kind) {
  uint32_t room = wire_room(kind, x->p, x->len);
  if (room == WIRE_NONE) return NULL;
  void *out = ar_alloc(a, wire_schema_of(kind)->size);
  wire_decode(kind, x->p, x->len, out, ar_alloc(a, room + 8));
  return out;
}

/* A failed answer, said on stderr: its exit code. */
static int failed(arena *a, const answer *x, const char *what) {
  const wire_error *e = as_kind(a, x, WK_ERROR);
  if (!e) {
    fprintf(stderr, "amgi: %s: %d ", what, x->status);
    fwrite(x->p, 1, x->len, stderr);
    fputc('\n', stderr);
    return x->status == 404 ? RC_NOT_FOUND : RC_FAIL;
  }
  if (e->mode == WIRE_MODE_LOCKED) return fputs(LOCKED_LINE "\n", stderr), RC_LOCKED;
  if (weq(e->error, MISSING_KEY_MESSAGE)) return fputs(NO_KEY_LINE "\n", stderr), RC_GEMINI;
  if (e->daily_cap) {
    fprintf(stderr, "gemini: the day's quota is spent (dailyCap): stop and tell the user. %.*s\n", (int)e->error.len, e->error.p);
    return RC_GEMINI;
  }
  if (x->status == 429)
    return fprintf(stderr, "gemini: rate limited, retryAfterMs=%u: %.*s\n", e->retry_after_ms, (int)e->error.len, e->error.p),
           RC_GEMINI;
  fprintf(stderr, "amgi: %s: %.*s\n", what, (int)e->error.len, e->error.p);
  if (e->mode == WIRE_MODE_NOT_FOUND || x->status == 404) return RC_NOT_FOUND;
  return RC_FAIL;
}

/* A GET of kind: the struct, or NULL with *rc said. */
static void *get(arena *a, const up_state *s, const char *path, uint32_t kind, int *rc) {
  answer x;
  if ((*rc = call(a, s, "GET", path, -1, NULL, CALL_MS, &x))) return NULL;
  if (x.status != 200) return *rc = failed(a, &x, path), NULL;
  void *out = as_kind(a, &x, kind);
  if (!out) fprintf(stderr, "amgi: GET %s answered something other than %s\n", path, wire_kind_name(kind)), *rc = RC_FAIL;
  return out;
}
/* A write of send_kind answered by kind. */
static void *send_call(arena *a, const up_state *s, const char *method, const char *path, uint32_t send_kind,
                       const void *send, uint32_t kind, int timeout_ms, int *rc, answer *raw) {
  answer x;
  if ((*rc = call(a, s, method, path, (int32_t)send_kind, send, timeout_ms, &x))) return NULL;
  if (raw) *raw = x;
  if (x.status != 200) return *rc = failed(a, &x, path), NULL;
  void *out = as_kind(a, &x, kind);
  if (!out) fprintf(stderr, "amgi: %s %s answered something other than %s\n", method, path, wire_kind_name(kind)), *rc = RC_FAIL;
  return out;
}

/* The state of a running `amgi up`, or RC_FAIL having said there is none. */
static int need_up(up_state *s) {
  int r = read_state(s);
  if (r <= 0 || !is_ours(s->pid)) return fputs(NOT_UP_LINE "\n", stderr), RC_FAIL;
  return 0;
}

/* ---- arguments: --name VALUE or --name=VALUE ---- */
typedef struct {
  const char *name;
  const char **value; /* NULL: a switch */
  int *on;
} opt;
static int parse_opts(int argc, char **argv, int from, opt *opts, size_t nopts, const char **positional) {
  for (int i = from; i < argc; i++) {
    const char *arg = argv[i];
    if (strncmp(arg, "--", 2) != 0) {
      if (positional && !*positional) {
        *positional = arg;
        continue;
      }
      fprintf(stderr, "amgi: unexpected argument: %s\n", arg);
      return -1;
    }
    const char *eq = strchr(arg, '=');
    size_t n = eq ? (size_t)(eq - arg) : strlen(arg);
    opt *o = NULL;
    for (size_t k = 0; k < nopts && !o; k++)
      if (strlen(opts[k].name) == n && !strncmp(opts[k].name, arg, n)) o = &opts[k];
    if (!o) return fprintf(stderr, "amgi: unknown option: %.*s\n", (int)n, arg), -1;
    if (!o->value) {
      if (eq) return fprintf(stderr, "amgi: %s takes no value\n", o->name), -1;
      *o->on = 1;
      continue;
    }
    if (eq) *o->value = eq + 1;
    else if (i + 1 < argc) *o->value = argv[++i];
    else return fprintf(stderr, "amgi: %s needs a value\n", o->name), -1;
  }
  return 0;
}

/* ---- up and down ---- */
static void stop(int pid) {
  kill(pid, SIGTERM);
  for (int waited = 0; waited < DOWN_WAIT_MS; waited += 50) {
    if (waitpid(pid, NULL, WNOHANG) == pid || (kill(pid, 0) != 0 && errno == ESRCH)) return;
    sleep_ms(50);
  }
}

/* The port in the server's startup line in the log ("cbase: listening 127.0.0.1:3000 http://..."), or 0. */
static int listening_port(void) {
  FILE *f = fopen(g_log, "r");
  if (!f) return 0;
  char line[1024];
  int port = 0;
  while (!port && fgets(line, sizeof line, f)) {
    const char *at = strstr(line, "cbase: listening ");
    if (at != line) continue;
    const char *addr = at + strlen("cbase: listening ");
    const char *end = strchr(addr, ' ');
    const char *colon = NULL;
    for (const char *p = addr; p < (end ? end : addr + strlen(addr)); p++)
      if (*p == ':') colon = p;
    if (colon) port = atoi(colon + 1);
  }
  fclose(f);
  return port;
}

static void show_log(void) {
  FILE *f = fopen(g_log, "r");
  if (!f) return;
  char line[1024];
  while (fgets(line, sizeof line, f)) fprintf(stderr, "  %s", line);
  fclose(f);
}

static int cmd_up(int argc, char **argv) {
  const char *key_file = NULL, *port_s = NULL, *profile = NULL;
  opt opts[] = {{"--key-file", &key_file, NULL}, {"--port", &port_s, NULL}, {"--profile", &profile, NULL}};
  if (parse_opts(argc, argv, 2, opts, 3, NULL)) return usage(NULL);
  up_state s;
  int have = read_state(&s);
  if (have > 0 && is_ours(s.pid)) {
    printf("amgi up: already running pid=%d port=%d profile=%s collection=%s\n", s.pid, s.port, s.profile, s.collection);
    return RC_OK;
  }
  if (have != 0) unlink(g_pidfile); /* a stale one: its server is gone */
  int port = 3000;
  if (port_s) {
    char *end;
    long v = strtol(port_s, &end, 10);
    if (*end || v < 0 || v > 65535) return usage("--port takes a number from 0 to 65535 (0: any free port)");
    port = (int)v;
  }
  char key[PATH_MAX] = "";
  if (key_file) {
    struct stat sb;
    /* stat only: the file is the server's to read, never this program's */
    if (stat(key_file, &sb) != 0 || !S_ISREG(sb.st_mode) || !realpath(key_file, key)) {
      fprintf(stderr, "amgi: --key-file %s: no such file\n", key_file);
      return RC_USAGE;
    }
  }
  int log = open(g_log, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (log < 0) return fprintf(stderr, "amgi: cannot write %s: %s\n", g_log, strerror(errno)), RC_FAIL;
  pid_t pid = fork();
  if (pid < 0) return fprintf(stderr, "amgi: fork: %s\n", strerror(errno)), RC_FAIL;
  if (pid == 0) {
    setsid();
    int devnull = open("/dev/null", O_RDONLY);
    if (devnull >= 0) dup2(devnull, 0);
    dup2(log, 1);
    dup2(log, 2);
    if (chdir(g_root) != 0) _exit(126);
    char listen[64];
    snprintf(listen, sizeof listen, "127.0.0.1:%d", port); /* loopback only */
    setenv("CBASE_LISTEN", listen, 1);
    if (key[0]) setenv("CBASE_ENV_FILE", key, 1);
    char *args[] = {g_self, "serve", NULL};
    execv(g_self, args);
    _exit(127);
  }
  close(log);
  int bound = 0;
  for (int waited = 0; !bound && waited < UP_WAIT_MS; waited += 50) {
    if (waitpid(pid, NULL, WNOHANG) == pid) {
      fprintf(stderr, "amgi up: the server did not start; its log (%s):\n", g_log);
      show_log();
      return RC_FAIL;
    }
    bound = listening_port();
    if (!bound) sleep_ms(50);
  }
  if (!bound) {
    stop(pid);
    fprintf(stderr, "amgi up: the server did not say it was listening within %ds; its log is %s\n", UP_WAIT_MS / 1000, g_log);
    return RC_FAIL;
  }

  /* Which collection: the profile asked for, or the one profile there is. */
  arena a = {0};
  int rc = RC_OK;
  memset(&s, 0, sizeof s);
  s.pid = pid;
  s.port = bound;
  const wire_profiles *p = get(&a, &s, "/api/anki/profiles", WK_PROFILES, &rc);
  const wire_profile *chosen = NULL;
  if (p) {
    for (uint32_t i = 0; i < p->nprofiles && profile && !chosen; i++)
      if (weq(p->profiles[i].name, profile)) chosen = &p->profiles[i];
    if (!profile && p->nprofiles == 1) chosen = &p->profiles[0];
    if (!chosen) {
      if (!p->nprofiles)
        fprintf(stderr, "amgi up: no Anki profile under %.*s: Anki makes one the first time it opens\n", (int)p->base_dir.len,
                p->base_dir.p);
      else {
        if (profile) fprintf(stderr, "amgi up: no profile named %s; the profiles are:\n", profile);
        else fputs("amgi up: several profiles: pass --profile NAME, one of:\n", stderr);
        for (uint32_t i = 0; i < p->nprofiles; i++) fprintf(stderr, "  %.*s\n", (int)p->profiles[i].name.len, p->profiles[i].name.p);
      }
      rc = p->nprofiles && !profile ? RC_USAGE : RC_NOT_FOUND;
    }
  }
  if (chosen) {
    snprintf(s.profile, sizeof s.profile, "%.*s", (int)chosen->name.len, chosen->name.p);
    snprintf(s.collection, sizeof s.collection, "%.*s", (int)chosen->collection_path.len, chosen->collection_path.p);
    /* The server's own check of the file (a -wal or -shm beside it is Anki's, the SQLite header). */
    const wire_status *st = get(&a, &s, "/api/anki/status", WK_STATUS, &rc);
    if (st && st->mode != WIRE_MODE_DIRECT) {
      if (st->mode == WIRE_MODE_LOCKED) fputs(LOCKED_LINE "\n", stderr), rc = RC_LOCKED;
      else if (st->mode == WIRE_MODE_NOT_FOUND) fprintf(stderr, "amgi up: no collection at %s\n", s.collection), rc = RC_NOT_FOUND;
      else if (st->mode == WIRE_MODE_DAMAGED) fputs("amgi up: " MSG_DAMAGED "\n", stderr), rc = RC_FAIL;
      else fprintf(stderr, "amgi up: the collection is %s, not one amgi can write\n", wire_mode_name(st->mode)), rc = RC_FAIL;
    }
  }
  ar_free(&a);
  if (rc != RC_OK) {
    stop(pid);
    return rc;
  }
  if (write_state(&s) != 0) {
    stop(pid);
    return fprintf(stderr, "amgi up: cannot write %s: %s\n", g_pidfile, strerror(errno)), RC_FAIL;
  }
  printf("amgi up pid=%d port=%d profile=%s collection=%s\n", s.pid, s.port, s.profile, s.collection);
  return RC_OK;
}

static int cmd_down(int argc, char **argv) {
  (void)argv;
  if (argc > 2) return usage("down takes no arguments");
  up_state s;
  int have = read_state(&s);
  if (have == 0) return puts("amgi down: not running"), RC_OK;
  if (have < 0 || !is_ours(s.pid)) {
    /* Never signal a pid this file names unless it is this binary: it may be reused by anything. */
    unlink(g_pidfile);
    puts("amgi down: not running (removed a stale pid file)");
    return RC_OK;
  }
  stop(s.pid);
  if (kill(s.pid, 0) == 0 && is_ours(s.pid))
    return fprintf(stderr, "amgi down: pid %d did not exit within %ds\n", s.pid, DOWN_WAIT_MS / 1000), RC_FAIL;
  unlink(g_pidfile);
  printf("amgi down pid=%d\n", s.pid);
  return RC_OK;
}

/* ---- status and install ---- */
static const char *yn(uint32_t v) { return v == 1 ? "yes" : v == 0 ? "no" : "unknown"; }

static int print_install(arena *a, const up_state *s) {
  int rc;
  const wire_install_state *i = get(a, s, "/api/anki/install", WK_INSTALL_STATE, &rc);
  if (!i) return rc;
  printf("install\tready=%s\taddons=%s\tup_to_date=%s\tnote_type_checked=%s\n", yn(i->ready), yn(i->installed),
         yn(i->up_to_date), yn(i->collection_checked));
  return RC_OK;
}

static int cmd_status(int argc, char **argv) {
  (void)argv;
  if (argc > 2) return usage("status takes no arguments");
  up_state s;
  int rc = need_up(&s);
  if (rc) return rc;
  arena a = {0};
  const wire_status *st = get(&a, &s, "/api/anki/status", WK_STATUS, &rc);
  if (st) {
    printf("status\tmode=%s\tschema=%u\tpid=%d\tport=%d\tprofile=", wire_mode_name(st->mode), st->schema_version, s.pid, s.port);
    put(s.profile, strlen(s.profile));
    printf("\tcollection=");
    put(s.collection, strlen(s.collection));
    putchar('\n');
    rc = print_install(&a, &s);
    if (!rc && st->mode == WIRE_MODE_LOCKED) fputs(LOCKED_LINE "\n", stderr), rc = RC_LOCKED;
  }
  ar_free(&a);
  return rc;
}

static int cmd_install(int argc, char **argv) {
  (void)argv;
  if (argc > 2) return usage("install takes no arguments");
  up_state s;
  int rc = need_up(&s);
  if (rc) return rc;
  arena a = {0};
  wire_q_install q = {{"", 0}};
  const wire_installed *r = send_call(&a, &s, "POST", "/api/anki/install", WK_Q_INSTALL, &q, WK_INSTALLED, CALL_MS, &rc, NULL);
  if (r) {
    fprintf(stderr, "amgi: %.*s\n", (int)r->message.len, r->message.p);
    rc = print_install(&a, &s);
  }
  ar_free(&a);
  return rc;
}

/* ---- decks ---- */
static void print_deck(const wire_deck *d) {
  printf("deck\t%lld\t%u\t", (long long)d->id, d->note_count);
  put_w(d->name);
  putchar('\n');
}

static const wire_deck *find_deck(const wire_decks *ds, const char *name) {
  for (uint32_t i = 0; i < ds->ndecks; i++)
    if (weq(ds->decks[i].name, name)) return &ds->decks[i];
  return NULL;
}

static int cmd_deck(int argc, char **argv) {
  if (argc < 3) return usage("deck takes add NAME or list");
  up_state s;
  int rc;
  if (!strcmp(argv[2], "list")) {
    if (argc > 3) return usage("deck list takes no arguments");
    if ((rc = need_up(&s))) return rc;
    arena a = {0};
    const wire_decks *ds = get(&a, &s, "/api/anki/decks", WK_DECKS, &rc);
    for (uint32_t i = 0; ds && i < ds->ndecks; i++) print_deck(&ds->decks[i]);
    ar_free(&a);
    return rc;
  }
  if (strcmp(argv[2], "add") != 0) return usage("deck takes add NAME or list");
  if (argc != 4 || !argv[3][0]) return usage("deck add takes one NAME (quote it when it has spaces; A::B is subdeck B of A)");
  if ((rc = need_up(&s))) return rc;
  arena a = {0};
  wire_q_deck_name q = {{argv[3], (uint32_t)strlen(argv[3])}};
  const wire_deck_created *made = send_call(&a, &s, "POST", "/api/anki/decks", WK_Q_DECK_NAME, &q, WK_DECK_CREATED, CALL_MS, &rc, NULL);
  if (made) {
    /* the read-back: the deck as the list now shows it */
    const wire_decks *ds = get(&a, &s, "/api/anki/decks", WK_DECKS, &rc);
    const wire_deck *d = NULL;
    for (uint32_t i = 0; ds && i < ds->ndecks && !d; i++)
      if (ds->decks[i].id == made->id) d = &ds->decks[i];
    if (d) {
      print_deck(d);
      if (!made->created) fputs("amgi: the deck was already there\n", stderr);
    } else if (ds) {
      fprintf(stderr, "amgi: deck %lld was made but the deck list does not show it\n", (long long)made->id), rc = RC_FAIL;
    }
  }
  ar_free(&a);
  return rc;
}

/* ---- cards ---- */
typedef struct {
  const wire_notetype *nt;
  amgi_fields idx;
} listening;

/* The amgi Listening note type and its fields, found by name as the app finds them (amgi_field_indexes). */
static int find_listening(arena *a, const wire_notetypes *nts, listening *out) {
  for (uint32_t i = 0; i < nts->nnotetypes; i++) {
    const wire_notetype *w = &nts->notetypes[i];
    if (!weq(w->name, AMGI_NOTETYPE_NAME)) continue;
    col_notetype c = {0};
    c.id = w->id;
    c.name = amgi_str(w->name);
    c.nfields = w->field_names.n;
    c.fields = ar_alloc(a, (c.nfields + 1) * sizeof(str));
    for (size_t f = 0; f < c.nfields; f++) c.fields[f] = amgi_str(w->field_names.v[f]);
    *out = (listening){w, amgi_field_indexes(a, &c)};
    return out->idx.cue >= 0 && out->idx.target >= 0;
  }
  return 0;
}

/* note ID FRONT BACK AUDIO: an amgi Listening note's Cue and Target and its two clips' references
 * (or "-"), and any other note's first two fields. */
static void print_note(const wire_note *n, const listening *l) {
  int amgi = l->nt && n->notetype_id == l->nt->id;
  int front = amgi ? l->idx.cue : 0, back = amgi ? l->idx.target : 1;
  printf("note\t%lld\t", (long long)n->id);
  if ((uint32_t)front < n->fields.n) put_w(n->fields.v[front]);
  putchar('\t');
  if ((uint32_t)back < n->fields.n) put_w(n->fields.v[back]);
  putchar('\t');
  int any = 0;
  int clips[2] = {amgi ? l->idx.cue_audio : -1, amgi ? l->idx.target_audio : -1};
  for (int k = 0; k < 2; k++)
    if (clips[k] >= 0 && (uint32_t)clips[k] < n->fields.n && n->fields.v[clips[k]].len) {
      if (any++) putchar(' ');
      put_w(n->fields.v[clips[k]]);
    }
  if (!any) putchar('-');
  putchar('\n');
}

/* The deck named NAME, and the note types, for a card command. */
static int card_context(arena *a, const up_state *s, const char *deck, const wire_deck **d, const wire_notetypes **nts) {
  int rc;
  const wire_decks *ds = get(a, s, "/api/anki/decks", WK_DECKS, &rc);
  if (!ds) return rc;
  if (!(*d = find_deck(ds, deck))) {
    fprintf(stderr, "amgi: no deck named \"%s\": amgi deck list shows the decks, amgi deck add makes one\n", deck);
    return RC_NOT_FOUND;
  }
  *nts = get(a, s, "/api/anki/notetypes", WK_NOTETYPES, &rc);
  return *nts ? RC_OK : rc;
}

/* Prints every note in deck d (or only the note `only`), a page of 200 at a time: 0, or the exit code. */
static int each_note(arena *a, const up_state *s, const wire_deck *d, const listening *l, int64_t only) {
  int found = 0;
  for (uint32_t offset = 0;;) {
    char path[128];
    snprintf(path, sizeof path, "/api/anki/decks/%lld/notes?offset=%u&limit=200", (long long)d->id, offset);
    int rc;
    const wire_notes *ns = get(a, s, path, WK_NOTES, &rc);
    if (!ns) return rc;
    for (uint32_t i = 0; i < ns->nnotes; i++)
      if (!only || ns->notes[i].id == only) print_note(&ns->notes[i], l), found = 1;
    if (!ns->has_more || !ns->nnotes || (only && found)) break;
    offset += ns->nnotes;
  }
  if (only && !found) return fprintf(stderr, "amgi: note %lld was added but reading the deck back does not show it\n", (long long)only), RC_FAIL;
  return RC_OK;
}

/* POST /card-text, waiting out the rate gate as it asks (it owns every wait: retryAfterMs exactly). */
static const wire_card_text *generate(arena *a, const up_state *s, const wire_q_card_text *q, int *rc) {
  for (int attempt = 0;; attempt++) {
    answer x = {0};
    const wire_card_text *t = send_call(a, s, "POST", "/api/anki/card-text", WK_Q_CARD_TEXT, q, WK_CARD_TEXT, GEN_MS, rc, &x);
    if (!t && *rc == RC_FAIL && x.status >= 500) *rc = RC_GEMINI; /* card-text's own failures are Gemini's */
    if (t || *rc != RC_GEMINI || x.status != 429 || attempt == 3) return t;
    const wire_error *e = as_kind(a, &x, WK_ERROR);
    if (!e || e->daily_cap || e->retry_after_ms == WIRE_NONE || e->retry_after_ms > MAX_WAIT_MS) return NULL;
    fprintf(stderr, "amgi: waiting %ums as Gemini's rate gate asks, then trying again\n", e->retry_after_ms);
    sleep_ms((int)e->retry_after_ms);
  }
}

static int cmd_card(int argc, char **argv) {
  if (argc < 3 || (strcmp(argv[2], "add") && strcmp(argv[2], "list"))) return usage("card takes add or list");
  int add = !strcmp(argv[2], "add");
  const char *deck = NULL, *front = NULL, *back = NULL, *text = NULL, *from = NULL, *to = NULL;
  int no_audio = 0;
  opt opts[] = {{"--deck", &deck, NULL}, {"--front", &front, NULL}, {"--back", &back, NULL}, {"--text", &text, NULL},
                {"--from", &from, NULL},  {"--to", &to, NULL},       {"--no-audio", NULL, &no_audio}};
  if (parse_opts(argc, argv, 3, opts, add ? 7 : 1, NULL)) return usage(NULL);
  if (!deck || !deck[0]) return usage("--deck NAME is required");
  int manual = front || back;
  if (add) {
    if (manual && (text || from || no_audio)) return usage("give --front and --back, or --text, --from and --to, not both");
    if (manual && (!front || !back || !front[0] || !back[0])) return usage("--front and --back are both required");
    if (!manual && (!text || !from || !to || !text[0] || !from[0] || !to[0]))
      return usage("card add needs --front and --back, or --text, --from and --to");
  }
  up_state s;
  int rc = need_up(&s);
  if (rc) return rc;
  arena a = {0};
  const wire_deck *d;
  const wire_notetypes *nts;
  listening l = {0};
  if ((rc = card_context(&a, &s, deck, &d, &nts))) goto out;
  int have_listening = find_listening(&a, nts, &l);
  if (!add) {
    rc = each_note(&a, &s, d, &l, 0);
    goto out;
  }
  if (!have_listening) {
    fputs("amgi: this collection has no \"" AMGI_NOTETYPE_NAME "\" note type, so amgi is not installed in it: "
          "ask the user, and with their yes run amgi install\n", stderr);
    rc = RC_NOT_FOUND;
    goto out;
  }
  size_t nf = l.nt->field_names.n;
  wire_str *fields = ar_alloc(&a, (nf + 1) * sizeof *fields);
  for (size_t f = 0; f < nf; f++) fields[f] = (wire_str){"", 0};
  const char *language = to ? to : "";
  if (manual) {
    fields[l.idx.cue] = (wire_str){front, (uint32_t)strlen(front)};
    fields[l.idx.target] = (wire_str){back, (uint32_t)strlen(back)};
  } else {
    wire_q_card_text q = {{text, (uint32_t)strlen(text)}, {from, (uint32_t)strlen(from)}, {to, (uint32_t)strlen(to)},
                          (uint8_t)(no_audio ? 0 : 1)};
    const wire_card_text *t = generate(&a, &s, &q, &rc);
    if (!t) goto out;
    fields[l.idx.cue] = t->front_text;
    fields[l.idx.target] = t->back_text;
    if (l.idx.target_audio >= 0) fields[l.idx.target_audio] = t->audio.reference;
    if (l.idx.cue_audio >= 0) fields[l.idx.cue_audio] = t->cue_audio.reference;
    if (t->front_text.len == t->back_text.len && !memcmp(t->front_text.p, t->back_text.p, t->front_text.len))
      fputs("amgi: warning: the two sides are the same text (the model echoed instead of translating)\n", stderr);
  }
  if (l.idx.language >= 0) fields[l.idx.language] = (wire_str){language, (uint32_t)strlen(language)};
  wire_q_note n = {d->id, l.nt->id, {fields, (uint32_t)nf}, {NULL, 0}, {language, (uint32_t)strlen(language)}, l.idx.target};
  const wire_note_added *added = send_call(&a, &s, "POST", "/api/anki/notes", WK_Q_NOTE, &n, WK_NOTE_ADDED, CALL_MS, &rc, NULL);
  if (added) rc = each_note(&a, &s, d, &l, added->note_id);
out:
  ar_free(&a);
  return rc;
}

int main(int argc, char **argv) {
  /* The server itself: cbase's serve, as build/amgi-serve runs it. */
  if (argc >= 2 && !strcmp(argv[1], "serve")) return cb_process_main(&cb_provider_local, cb_main_app, argc, argv);
  if (argc < 2) return usage(NULL);
  if (!strcmp(argv[1], "help") || !strcmp(argv[1], "--help") || !strcmp(argv[1], "-h")) return fputs(USAGE, stdout), RC_OK;
  if (find_self()) return fprintf(stderr, "amgi: cannot find this program's own path\n"), RC_FAIL;
  const char *c = argv[1];
  if (!strcmp(c, "up")) return cmd_up(argc, argv);
  if (!strcmp(c, "down")) return cmd_down(argc, argv);
  if (!strcmp(c, "status")) return cmd_status(argc, argv);
  if (!strcmp(c, "install")) return cmd_install(argc, argv);
  if (!strcmp(c, "deck")) return cmd_deck(argc, argv);
  if (!strcmp(c, "card")) return cmd_card(argc, argv);
  fprintf(stderr, "amgi: no command %s\n", c);
  return usage(NULL);
}
