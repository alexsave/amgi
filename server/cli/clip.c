/* amgi-clip: one clip, generated on demand, for a caller that is not C (the Anki add-on's Fill missing
 * audio, anki/addon/amgi_bridge/generator.py). This comment is the contract, and the add-on is the
 * other side of it: the arguments, the exit codes 0 to 4, what stdout and stderr carry, and the
 * key's lookup. The generation is server/amgi's card_generate_audio, through the one Gemini client
 * (gemini.c) and the one rate gate of the process (gate.c), so a clip made here meets the same
 * validation the server's own clips meet.
 *
 *   amgi-clip --text <text> --language <code> --out <path.wav> [--reading <text>]
 *
 *   exit 0  the clip was written to --out (written under a temporary name and renamed, so a caller
 *           never sees half a clip); nothing on stdout or stderr
 *   exit 1  no clip: no key, a network or API error, the validation gave up, or --out cannot be
 *           written; the last stderr line is the message to show a person
 *   exit 2  usage: a missing, unknown or valueless argument (nothing was attempted)
 *   exit 3  rate limited: stdout is one line `retry-after-ms=<n>`
 *   exit 4  the day's Gemini cap is spent
 *
 * On exit 1, 3 and 4 a clip left at --out by an earlier run is removed, so the file's existence says
 * whether this run made it. The key is GEMINI_API_KEY from the environment, else the same key from
 * the file AMGI_CLIP_ENV_FILE names (default .env.local, read from the working directory: run from
 * the repository root, it is the file the server reads its key from too). GEMINI_API_BASE moves the
 * endpoint (the tests' fake). */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "env_file.h"
#include "../amgi/cards.h"
#include "../amgi/gemini.h"
#include "../amgi/messages.h"

#define USAGE "Usage: amgi-clip --text <text> --language <code> --out <path.wav> [--reading <text>]\n"
#define ENV_FILE_DEFAULT ".env.local"
#define EXIT_FAIL 1
#define EXIT_USAGE 2
#define EXIT_RATE_LIMITED 3
#define EXIT_DAILY_CAP 4

typedef struct {
  const char *text, *language, *out, *reading;
  int help;
} clip_opts;

/* The field a value flag fills, or NULL for a flag this tool does not have. */
static const char **slot_of(clip_opts *o, const char *flag) {
  if (!strcmp(flag, "--text")) return &o->text;
  if (!strcmp(flag, "--language")) return &o->language;
  if (!strcmp(flag, "--out")) return &o->out;
  if (!strcmp(flag, "--reading")) return &o->reading;
  return NULL;
}

/* The arguments, in order: 0, or -1 with the sentence a usage error names in `problem`. A repeated
 * flag takes its last value, and a value may begin with "--" (the word after a value flag is always
 * its value). */
static int parse_args(int argc, char **argv, clip_opts *o, char *problem, size_t cap) {
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!strcmp(arg, "--help") || !strcmp(arg, "-h")) {
      o->help = 1;
      continue;
    }
    const char **slot = slot_of(o, arg);
    if (!slot) {
      snprintf(problem, cap, "unknown option %s", arg);
      return -1;
    }
    if (i + 1 >= argc) {
      snprintf(problem, cap, "%s needs a value", arg);
      return -1;
    }
    *slot = argv[++i];
  }
  return 0;
}

/* The clip's bytes to --out, under a temporary name in the same directory and then renamed over it. */
static int write_clip(const char *out, str wav) {
  char tmp[PATH_MAX];
  snprintf(tmp, sizeof tmp, "%s.%ld.tmp", out, (long)getpid());
  FILE *f = fopen(tmp, "wb");
  int bad = !f;
  if (f) {
    bad = fwrite(wav.p, 1, wav.n, f) != wav.n;
    if (fclose(f)) bad = 1;
  }
  if (!bad && rename(tmp, out) == 0) return 0;
  fprintf(stderr, "cannot write %s: %s\n", out, strerror(errno));
  unlink(tmp);
  return -1;
}

int main(int argc, char **argv) {
  clip_opts o = {0};
  char problem[300];
  if (parse_args(argc, argv, &o, problem, sizeof problem)) {
    fprintf(stderr, "%s\n%s", problem, USAGE);
    return EXIT_USAGE;
  }
  if (o.help) {
    fputs(USAGE, stdout);
    return 0;
  }
  const char *names[3] = {"--text", "--language", "--out"};
  const char *values[3] = {o.text, o.language, o.out};
  char missing[64] = "";
  for (int i = 0; i < 3; i++) {
    if (values[i] && *values[i]) continue;
    if (*missing) strcat(missing, ", ");
    strcat(missing, names[i]);
  }
  if (*missing) {
    fprintf(stderr, "missing required option(s): %s\n%s", missing, USAGE);
    return EXIT_USAGE;
  }

  /* The environment wins, and the file only supplies what the environment does not set. A missing or
   * malformed file is no key at all: the missing-key message below says what to do. */
  const char *env_file = getenv("AMGI_CLIP_ENV_FILE");
  if (!env_file || !*env_file) env_file = ENV_FILE_DEFAULT;
  char env_err[512];
  (void)cb_env_file_load(env_file, env_err, sizeof env_err);
  const char *key = getenv("GEMINI_API_KEY");
  if (!key || !*key) {
    fprintf(stderr, "%s\n", MISSING_KEY_MESSAGE);
    return EXIT_FAIL;
  }

  char gem_msg[512];
  if (gem_open(gem_msg, sizeof gem_msg)) {
    fprintf(stderr, "%s\n", gem_msg);
    return EXIT_FAIL;
  }

  arena a = {0};
  str wav = {0};
  gem_err e = {0};
  str reading = o.reading ? str_c(o.reading) : (str){"", 0};
  int failed = card_generate_audio(&a, str_c(o.text), str_c(o.language), reading, &wav, &e) != 0;
  int code = 0;
  if (failed) {
    fprintf(stderr, "%.*s\n", (int)e.message.n, e.message.p);
    unlink(o.out); /* a failed run leaves no clip at --out, so a stale one cannot pass for this run's */
    if (e.kind == GE_RATE) {
      long long wait = e.retry_after_ms < 0 ? 0 : (long long)e.retry_after_ms;
      printf("retry-after-ms=%lld\n", wait);
      code = EXIT_RATE_LIMITED;
    } else if (e.kind == GE_DAILY) {
      code = EXIT_DAILY_CAP;
    } else {
      code = EXIT_FAIL;
    }
  } else if (write_clip(o.out, wav)) {
    code = EXIT_FAIL;
  }
  fflush(stdout);
  gem_close();
  ar_free(&a);
  return code;
}
