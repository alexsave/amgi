/* `amgi starter-audio`: records the starter deck's clips, so they can be committed. The port of scripts/build-starter-audio.js.
 *
 *   amgi starter-audio              record whatever is missing
 *   amgi starter-audio --rerecord   record every clip again
 *   amgi starter-audio --check      report, write nothing, make no Gemini call (exit 1 when a clip is missing)
 *   ... --only ja,ko                limit to some languages
 *   ... --model gemini-3.8-flash-tts   the other named speech model (default: the lighter one the shipped clips were made with)
 *   ... --dir DIR                   the starter folder (default anki/starter: media/ and voices.tsv in it)
 *   ... --cache DIR                 where validated takes are kept (default .cache/starter-audio, gitignored)
 *
 * The starter deck exists for people who have downloaded amgi and have no Gemini key (starter.c). Everything else in amgi
 * generates audio on demand and pays for it per clip; this one deck cannot, by definition, so its clips ship with the source.
 * That is the whole reason this is a command and not something the app does at runtime. It is a dev tool: nothing at runtime
 * runs it or needs what it needs (ffmpeg).
 *
 * HOW A CLIP IS MADE. Through the real pipeline, in process: card_generate_audio (cards.c), which is Gemini speech, then the
 * transcription check and, on a mismatch, the audio judge every card gets, all behind the process's one rate gate. The starter
 * phrases carry no stored reading, so Japanese and Chinese clips are checked by transcript, and judged only on a mismatch,
 * exactly as a re-recorded card is. A clip that does not validate is NOT shipped: the run lists it and exits 5, and nothing
 * under the starter folder changes until every clip asked for has validated.
 *
 * MODEL. Speech runs on --model; transcription and the judge stay on the runtime models. The model is recorded per clip in
 * voices.tsv, and a cached take made with a different model is recorded again rather than reused.
 *
 * DAILY CAPS. A per-day cap stops the run at once (another clip would only be refused too): the cache keeps what passed, the
 * run says how many clips are done and how many remain, and nothing is shipped. A per-minute limit is waited out.
 *
 * VOICES. Each clip's voice is drawn from the voice pool by a generator seeded from STARTER_SEED and the clip's own name, so
 * the same seed gives the same voice for the same clip on every run, however the run was interrupted and resumed. A retry
 * inside the pipeline draws the next voice from the same generator. voices.tsv records which model and voice made each clip.
 *
 * RE-RUNNABLE. Each validated clip is kept as WAV in the cache as soon as it passes (takes.tsv beside them names the model and
 * voice), so an interrupted or partly failed run picks up where it stopped and never pays twice for a clip.
 *
 * SIZE. The shipped clips are mp3, about 64 kbps mono, converted from the validated WAV with ffmpeg: a WAV starter set would
 * be about 48 KB per second of speech in the repo instead of about 8. The app plays both formats; only these shipped files
 * are mp3. ffmpeg is found on PATH and run only when a clip is converted; a missing ffmpeg is said before any Gemini call.
 *
 * NAMES. Clips are named by amgi_media_name (web.c), the hash every clip of amgi's is named by, with the mp3 extension, so
 * starter.c finds them by the same hash amgi would give the sentence, and the names never change when a clip is re-recorded.
 *
 * KEY. GEMINI_API_KEY from the environment, else the one in CBASE_ENV_FILE (the server's own lookup), else .env.local at the
 * repository root. Costs one Gemini TTS call plus its checks per clip: 180 clips from cold, far past the free tier's 10
 * requests per model per day. */
#include <errno.h>
#include <limits.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "amgi.h"
#include "cards.h"
#include "env_file.h"
#include "gemini.h"
#include "messages.h"
#include "../collection/rng.h"

/* The one seed the starter voices are drawn from. Change it to re-roll every voice. */
#define STARTER_SEED 20261108u
#define MP3_BITRATE "64k"
#define STARTER_MODEL GEM_TTS_LITE_MODEL
enum { RC_OK = 0, RC_FAIL = 1, RC_USAGE = 4, RC_GEMINI = 5 };
#define USAGE \
    "usage: amgi starter-audio [--check] [--rerecord] [--only ja,ko] [--model MODEL] [--dir DIR] [--cache DIR]\n" \
    "  MODEL is " GEM_TTS_LITE_MODEL " (the default) or " GEM_TTS_MODEL "\n"

typedef struct {
    int check, rerecord;
    const char *only, *model, *dir, *cache;
} sa_opts;

typedef struct {
    str language, text, name; /* name: amgi-<hash>.mp3 */
    int wanted;
} sa_clip;

typedef struct {
    char name[128], language[16], model[64], voice[32];
    int attempts;
} sa_take;

static int sa_usage(const char *why) {
    if (why) fprintf(stderr, "amgi starter-audio: %s\n", why);
    fputs(USAGE, stderr);
    return RC_USAGE;
}

static int parse_args(int argc, char **argv, sa_opts *o) {
    for (int i = 2; i < argc; i++) {
        const char *arg = argv[i];
        const char **slot = NULL;
        if (!strcmp(arg, "--check")) o->check = 1;
        else if (!strcmp(arg, "--rerecord")) o->rerecord = 1;
        else if (!strcmp(arg, "--only")) slot = &o->only;
        else if (!strcmp(arg, "--model")) slot = &o->model;
        else if (!strcmp(arg, "--dir")) slot = &o->dir;
        else if (!strcmp(arg, "--cache")) slot = &o->cache;
        else return fprintf(stderr, "amgi starter-audio: unknown option %s\n", arg), -1;
        if (!slot) continue;
        if (i + 1 >= argc) return fprintf(stderr, "amgi starter-audio: %s needs a value\n", arg), -1;
        *slot = argv[++i];
    }
    return 0;
}

static int only_has(const char *only, str code) {
    if (!only) return 1;
    for (const char *p = only; *p;) {
        const char *end = strchr(p, ',');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        if (n == code.n && !memcmp(p, code.p, n)) return 1;
        p += n + (end ? 1 : 0);
    }
    return 0;
}

/* Every code --only names must be a language in the table, else it is a typo that would record nothing. */
static int only_valid(const char *only, char *bad, size_t cap) {
    if (!only) return 1;
    for (const char *p = only; *p;) {
        const char *end = strchr(p, ',');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        int known = n == 0;
        for (size_t c = 0; c < AMGI_NSTARTER_LANGUAGES && !known; c++)
            known = strlen(AMGI_STARTER_PHRASES[c].code) == n && !memcmp(AMGI_STARTER_PHRASES[c].code, p, n);
        if (!known) return snprintf(bad, cap, "%.*s", (int)n, p), 0;
        p += n + (end ? 1 : 0);
    }
    return 1;
}

/* A clip's own seed: STARTER_SEED and its name WITHOUT AMGI_MEDIA_PREFIX (the 20-hex hash and the extension), so renaming the
 * prefix never changes a voice again. The sha1's first four bytes are read little-endian, as the script this replaces read
 * them. The shipped voices cannot be reproduced: they were drawn from the old prefixed name. */
static uint32_t clip_seed(const char *name) {
    char hex[41];
    const char *bare = !strncmp(name, AMGI_MEDIA_PREFIX, strlen(AMGI_MEDIA_PREFIX)) ? name + strlen(AMGI_MEDIA_PREFIX) : name;
    sha1_hex(bare, strlen(bare), hex);
    uint32_t w = 0;
    for (int i = 0; i < 4; i++) {
        unsigned byte;
        sscanf(hex + 2 * i, "%2x", &byte);
        w |= (uint32_t)byte << (8 * i);
    }
    return STARTER_SEED ^ w;
}

static uint32_t draw_of(void *ud) { return rng_next(ud); }

/* ---- files ---- */
static int read_whole(const char *path, str *out, arena *a) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    buf b = {0};
    char chunk[1 << 14];
    size_t r;
    while ((r = fread(chunk, 1, sizeof chunk, f)) > 0) buf_put(&b, chunk, r);
    fclose(f);
    *out = buf_str(a, &b);
    buf_free(&b);
    return 0;
}

/* Under a temporary name in the same directory, then renamed over path: no one sees half a file. */
static int write_whole(const char *path, const void *p, size_t n) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.%ld.tmp", path, (long)getpid());
    FILE *f = fopen(tmp, "wb");
    int bad = !f;
    if (f) {
        bad = fwrite(p, 1, n, f) != n;
        if (fclose(f)) bad = 1;
    }
    if (!bad && rename(tmp, path) == 0) return 0;
    fprintf(stderr, "amgi starter-audio: cannot write %s: %s\n", path, strerror(errno));
    unlink(tmp);
    return -1;
}

static int exists(const char *path) {
    struct stat sb;
    return stat(path, &sb) == 0;
}

/* mkdir -p: 0, or -1 with errno. */
static int make_dirs(const char *path) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p != '/') continue;
        *p = 0;
        if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
        *p = '/';
    }
    return mkdir(tmp, 0755) != 0 && errno != EEXIST ? -1 : 0;
}

static void stem_of(const char *name, char *out, size_t cap) {
    snprintf(out, cap, "%s", name);
    char *dot = strrchr(out, '.');
    if (dot) *dot = 0;
}

/* The lines of a TSV file, each split on tabs into at most `max` cells (the cells point into the text, which is edited). */
static char **lines_of(arena *a, const char *path, size_t *n) {
    str text;
    *n = 0;
    if (read_whole(path, &text, a)) return NULL;
    char *copy = ar_dup(a, text.p, text.n);
    size_t count = 1;
    for (size_t i = 0; i < text.n; i++) count += copy[i] == '\n';
    char **lines = ar_alloc(a, (count + 1) * sizeof *lines);
    for (char *p = copy; *p;) {
        char *end = strchr(p, '\n');
        if (end) *end = 0;
        lines[(*n)++] = p;
        p = end ? end + 1 : p + strlen(p);
    }
    return lines;
}

static sa_take *read_takes(arena *a, const char *cache, size_t *n) {
    char path[PATH_MAX];
    snprintf(path, sizeof path, "%s/takes.tsv", cache);
    size_t nl;
    char **lines = lines_of(a, path, &nl);
    sa_take *takes = ar_alloc(a, (nl + 1) * sizeof *takes);
    *n = 0;
    for (size_t i = 0; i < nl; i++) {
        char *cell[5] = {0};
        char *p = lines[i];
        for (int k = 0; k < 5 && p; k++) {
            cell[k] = p;
            p = strchr(p, '\t');
            if (p) *p++ = 0;
        }
        if (!cell[4] || !*cell[0]) continue;
        sa_take *t = &takes[(*n)++];
        snprintf(t->name, sizeof t->name, "%s", cell[0]);
        snprintf(t->language, sizeof t->language, "%s", cell[1]);
        snprintf(t->model, sizeof t->model, "%s", cell[2]);
        snprintf(t->voice, sizeof t->voice, "%s", cell[3]);
        t->attempts = atoi(cell[4]);
    }
    return takes;
}

/* The latest take of a clip, or NULL (a later line of takes.tsv replaces an earlier one). */
static sa_take *take_of(sa_take *takes, size_t n, const char *name) {
    for (size_t i = n; i-- > 0;)
        if (!strcmp(takes[i].name, name)) return &takes[i];
    return NULL;
}

/* ---- ffmpeg ---- */
/* The first executable named ffmpeg on PATH, or 0. */
static int find_ffmpeg(char *out, size_t cap) {
    const char *path = getenv("PATH");
    if (!path) return 0;
    for (const char *p = path; *p;) {
        const char *end = strchr(p, ':');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        snprintf(out, cap, "%.*s/ffmpeg", (int)(n ? n : 1), n ? p : ".");
        if (access(out, X_OK) == 0) return 1;
        p += n + (end ? 1 : 0);
    }
    return 0;
}

static int to_mp3(const char *ffmpeg, const char *wav, const char *mp3) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.%ld.tmp", mp3, (long)getpid());
    char *argv[] = {"ffmpeg", "-y", "-loglevel", "error", "-i", (char *)wav, "-ac", "1", "-codec:a", "libmp3lame", "-b:a",
                    MP3_BITRATE, "-f", "mp3", tmp, NULL};
    /* fork and exec, as `amgi up` starts the server: posix_spawn is out of reach here, because cbase's own spawn.h (on the
     * include path) answers to the system header's name. */
    pid_t pid = fork();
    if (pid < 0) return fprintf(stderr, "amgi starter-audio: cannot run ffmpeg: %s\n", strerror(errno)), -1;
    if (pid == 0) {
        execv(ffmpeg, argv);
        _exit(127);
    }
    int status;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        unlink(tmp);
        return fprintf(stderr, "amgi starter-audio: ffmpeg failed on %s\n", wav), -1;
    }
    if (rename(tmp, mp3) != 0) {
        unlink(tmp);
        return fprintf(stderr, "amgi starter-audio: cannot write %s: %s\n", mp3, strerror(errno)), -1;
    }
    return 0;
}

/* ---- the manifest ---- */
/* voices.tsv's line for a clip, as it stands (NULL: none). */
static const char *manifest_row(char **lines, size_t n, const char *name) {
    size_t len = strlen(name);
    for (size_t i = 1; i < n; i++)
        if (!strncmp(lines[i], name, len) && lines[i][len] == '\t') return lines[i];
    return NULL;
}

/* The model voices.tsv says made a shipped clip, or "" when it has no row. */
static void manifest_model(char **lines, size_t n, const char *name, char *out, size_t cap) {
    const char *row = manifest_row(lines, n, name);
    out[0] = 0;
    if (!row) return;
    const char *tab = strchr(strchr(row, '\t') ? strchr(row, '\t') + 1 : "", '\t');
    if (!tab) return;
    const char *end = strchr(tab + 1, '\t');
    snprintf(out, cap, "%.*s", (int)(end ? end - tab - 1 : (long)strlen(tab + 1)), tab + 1);
}

static sa_clip *build_clips(arena *a, const sa_opts *o, size_t *n) {
    sa_clip *clips = ar_alloc(a, AMGI_NSTARTER_LANGUAGES * STARTER_NPHRASES * sizeof *clips);
    *n = 0;
    for (size_t c = 0; c < AMGI_NSTARTER_LANGUAGES; c++) {
        str code = str_c(AMGI_STARTER_PHRASES[c].code);
        if (!only_has(o->only, code)) continue;
        for (size_t i = 0; i < STARTER_NPHRASES; i++) {
            str text = str_c(AMGI_STARTER_PHRASES[c].phrases[i]);
            clips[(*n)++] = (sa_clip){code, text, amgi_media_name(a, text, code, "mp3"), 0};
        }
    }
    return clips;
}

static int is_daily_cap(const gem_err *e) { return e->kind == GE_DAILY; }

static void sleep_ms(int64_t ms) {
    struct timespec ts = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
}

int amgi_starter_audio(int argc, char **argv, const char *root) {
    sa_opts o = {0};
    if (parse_args(argc, argv, &o)) return sa_usage(NULL);
    char bad[64];
    if (!only_valid(o.only, bad, sizeof bad)) {
        char why[128];
        snprintf(why, sizeof why, "--only names no language amgi has: %s", bad);
        return sa_usage(why);
    }
    const char *model = o.model ? o.model : STARTER_MODEL;
    if (strcmp(model, GEM_TTS_MODEL) && strcmp(model, GEM_TTS_LITE_MODEL)) return sa_usage("--model must be " GEM_TTS_LITE_MODEL " or " GEM_TTS_MODEL);

    arena a = {0};
    char dir[PATH_MAX], media[PATH_MAX], manifest[PATH_MAX], cache[PATH_MAX];
    if (o.dir) snprintf(dir, sizeof dir, "%s", o.dir);
    else snprintf(dir, sizeof dir, "%s/anki/starter", root);
    snprintf(media, sizeof media, "%s/media", dir);
    snprintf(manifest, sizeof manifest, "%s/voices.tsv", dir);
    if (o.cache) snprintf(cache, sizeof cache, "%s", o.cache);
    else snprintf(cache, sizeof cache, "%s/.cache/starter-audio", root);

    size_t nclips;
    sa_clip *clips = build_clips(&a, &o, &nclips);
    size_t nmanifest;
    char **manifest_lines = lines_of(&a, manifest, &nmanifest);
    size_t shipped = 0, nwanted = 0;
    for (size_t i = 0; i < nclips; i++) {
        char path[PATH_MAX];
        snprintf(path, sizeof path, "%s/%.*s", media, (int)clips[i].name.n, clips[i].name.p);
        int have = exists(path);
        shipped += have;
        clips[i].wanted = o.rerecord || !have;
        nwanted += clips[i].wanted;
    }

    if (o.check) {
        size_t missing = 0;
        for (size_t c = 0; c < AMGI_NSTARTER_LANGUAGES; c++) {
            str code = str_c(AMGI_STARTER_PHRASES[c].code);
            size_t have = 0, none = 0, other = 0;
            for (size_t i = 0; i < nclips; i++) {
                if (!str_eq(clips[i].language, code)) continue;
                char path[PATH_MAX], recorded[64];
                snprintf(path, sizeof path, "%s/%.*s", media, (int)clips[i].name.n, clips[i].name.p);
                if (!exists(path)) {
                    none++;
                    continue;
                }
                have++;
                manifest_model(manifest_lines, nmanifest, str_z(&a, clips[i].name), recorded, sizeof recorded);
                other += strcmp(recorded, model) != 0;
            }
            if (!have && !none) continue;
            printf("%s: %zu shipped", AMGI_STARTER_PHRASES[c].code, have);
            if (none) printf(", %zu missing", none);
            if (other) printf(", %zu recorded with another model than %s", other, model);
            putchar('\n');
            missing += none;
        }
        for (size_t i = 0; i < nclips; i++) {
            char path[PATH_MAX];
            snprintf(path, sizeof path, "%s/%.*s", media, (int)clips[i].name.n, clips[i].name.p);
            if (!exists(path))
                printf("missing\t%.*s\t%.*s\t%.*s\n", (int)clips[i].language.n, clips[i].language.p, (int)clips[i].name.n,
                       clips[i].name.p, (int)clips[i].text.n, clips[i].text.p);
        }
        printf("%zu of %zu clips shipped; %zu missing\n", shipped, nclips, missing);
        ar_free(&a);
        return missing ? RC_FAIL : RC_OK;
    }

    printf("%zu of %zu clips shipped; %zu to record with %s\n", shipped, nclips, nwanted, model);
    if (!nwanted) return ar_free(&a), RC_OK;

    /* Everything a run needs is checked before the first Gemini call. */
    char ffmpeg[PATH_MAX];
    if (!find_ffmpeg(ffmpeg, sizeof ffmpeg)) {
        fputs("amgi starter-audio: ffmpeg is not on PATH: it converts each clip to mp3 (a dev-only dependency: brew install ffmpeg)\n", stderr);
        return ar_free(&a), RC_FAIL;
    }
    const char *env_file = getenv("CBASE_ENV_FILE");
    char env_default[PATH_MAX], env_err[512];
    if (!env_file || !*env_file) {
        snprintf(env_default, sizeof env_default, "%s/.env.local", root);
        env_file = env_default;
    }
    (void)cb_env_file_load(env_file, env_err, sizeof env_err);
    const char *key = getenv("GEMINI_API_KEY");
    if (!key || !*key) {
        fprintf(stderr, "%s\n", MISSING_KEY_MESSAGE);
        return ar_free(&a), RC_GEMINI;
    }
    char gem_msg[512];
    if (gem_open(gem_msg, sizeof gem_msg)) {
        fprintf(stderr, "%s\n", gem_msg);
        return ar_free(&a), RC_GEMINI;
    }
    gem_set_tts_model(model);

    char takes_path[PATH_MAX];
    snprintf(takes_path, sizeof takes_path, "%s/takes.tsv", cache);
    if (make_dirs(cache)) {
        fprintf(stderr, "amgi starter-audio: cannot make %s: %s\n", cache, strerror(errno));
        gem_close();
        return ar_free(&a), RC_FAIL;
    }
    size_t ntakes;
    sa_take *takes = ar_alloc(&a, (nclips + 1) * sizeof *takes);
    {
        sa_take *old = read_takes(&a, cache, &ntakes);
        memcpy(takes, old, ntakes * sizeof *takes);
    }
    size_t failed = 0, done_total = 0, index = 0;
    char **failures = ar_alloc(&a, (nwanted + 1) * sizeof *failures);
    int rc = RC_OK;
    for (size_t i = 0; i < nclips && rc == RC_OK; i++) {
        if (!clips[i].wanted) continue;
        index++;
        const char *name = str_z(&a, clips[i].name);
        char stem[128], wav_path[PATH_MAX];
        stem_of(name, stem, sizeof stem);
        snprintf(wav_path, sizeof wav_path, "%s/%s.wav", cache, stem);
        sa_take *cached = take_of(takes, ntakes, name);
        if (exists(wav_path) && cached && !strcmp(cached->model, model)) {
            printf("%zu/%zu %.*s cached (%s)\n", index, nwanted, (int)clips[i].language.n, clips[i].language.p, cached->voice);
            done_total++;
            continue;
        }
        /* One generator per clip: the voice is a function of the seed and the name alone. A rate wait retries the same clip and
         * keeps drawing from it, as a retry inside the pipeline does. */
        rng gen;
        rng_seed(&gen, clip_seed(name));
        gem_set_voice_draw(draw_of, &gen);
        for (;;) {
            arena clip_arena = {0};
            str wav = {0};
            gem_err e = {0};
            card_audio_take take;
            int bad_take = card_generate_audio_take(&clip_arena, NULL, clips[i].text, clips[i].language, S(""), &wav, &take, &e);
            if (!bad_take) {
                if (write_whole(wav_path, wav.p, wav.n)) {
                    ar_free(&clip_arena);
                    rc = RC_FAIL;
                    break;
                }
                FILE *f = fopen(takes_path, "ab");
                if (!f || fprintf(f, "%s\t%.*s\t%s\t%s\t%d\n", name, (int)clips[i].language.n, clips[i].language.p, model, take.voice,
                                  take.attempts) < 0 || fclose(f)) {
                    fprintf(stderr, "amgi starter-audio: cannot write %s: %s\n", takes_path, strerror(errno));
                    ar_free(&clip_arena);
                    rc = RC_FAIL;
                    break;
                }
                sa_take *t = &takes[ntakes++];
                snprintf(t->name, sizeof t->name, "%s", name);
                snprintf(t->language, sizeof t->language, "%.*s", (int)clips[i].language.n, clips[i].language.p);
                snprintf(t->model, sizeof t->model, "%s", model);
                snprintf(t->voice, sizeof t->voice, "%s", take.voice);
                t->attempts = take.attempts;
                printf("%zu/%zu %.*s %s%s\n", index, nwanted, (int)clips[i].language.n, clips[i].language.p, take.voice,
                       take.attempts > 1 ? " (more than one attempt)" : "");
                done_total++;
                ar_free(&clip_arena);
                break;
            }
            if (is_daily_cap(&e)) {
                fprintf(stderr, "\nStopped at a daily cap: %.*s\n", (int)e.message.n, e.message.p);
                fprintf(stderr, "%zu of %zu clips are validated and cached; %zu remain. Nothing under %s was changed; run again after the reset to continue.\n",
                        done_total, nwanted, nwanted - done_total, dir);
                ar_free(&clip_arena);
                rc = RC_GEMINI;
                break;
            }
            if (e.kind == GE_RATE) {
                /* A limit no wait inside one request covers: a quota, not a verdict on the clip, so wait it out. */
                int64_t wait = e.retry_after_ms > 0 ? e.retry_after_ms : 60000;
                printf("  (rate limited; waiting %lld s)\n", (long long)((wait + 999) / 1000));
                fflush(stdout);
                ar_free(&clip_arena);
                sleep_ms(wait);
                continue;
            }
            if (e.kind == GE_FATAL) {
                fprintf(stderr, "%.*s\n", (int)e.message.n, e.message.p);
                ar_free(&clip_arena);
                rc = RC_GEMINI;
                break;
            }
            printf("%zu/%zu %.*s FAILED after %d attempt(s): %.*s\n", index, nwanted, (int)clips[i].language.n, clips[i].language.p,
                   take.attempts, (int)e.message.n, e.message.p);
            failures[failed++] = ar_fmt(&a, "  %.*s \"%.*s\": %.*s", (int)clips[i].language.n, clips[i].language.p,
                                        (int)clips[i].text.n, clips[i].text.p, (int)e.message.n, e.message.p);
            ar_free(&clip_arena);
            break;
        }
    }
    gem_set_voice_draw(NULL, NULL);
    gem_close();
    if (rc != RC_OK) return ar_free(&a), rc;
    if (failed) {
        fprintf(stderr, "\n%zu clip(s) did not validate; nothing under %s was changed:\n", failed, dir);
        for (size_t i = 0; i < failed; i++) fprintf(stderr, "%s\n", failures[i]);
        return ar_free(&a), RC_GEMINI;
    }

    if (make_dirs(media)) {
        fprintf(stderr, "amgi starter-audio: cannot make %s: %s\n", media, strerror(errno));
        return ar_free(&a), RC_FAIL;
    }
    for (size_t i = 0; i < nclips; i++) {
        if (!clips[i].wanted) continue;
        const char *name = str_z(&a, clips[i].name);
        char stem[128], wav_path[PATH_MAX], mp3_path[PATH_MAX];
        stem_of(name, stem, sizeof stem);
        snprintf(wav_path, sizeof wav_path, "%s/%s.wav", cache, stem);
        snprintf(mp3_path, sizeof mp3_path, "%s/%s", media, name);
        if (to_mp3(ffmpeg, wav_path, mp3_path)) return ar_free(&a), RC_FAIL;
    }

    /* Which model and voice made each shipped clip, in phrase order. A clip converted now has its take; any other keeps the row
     * it has (a run that records some languages must not forget the others); a clip that is not shipped has no row. */
    buf out = {0};
    buf_c(&out, "file\tlanguage\tmodel\tvoice\tattempts\ttext\n");
    for (size_t c = 0; c < AMGI_NSTARTER_LANGUAGES; c++) {
        str code = str_c(AMGI_STARTER_PHRASES[c].code);
        for (size_t k = 0; k < STARTER_NPHRASES; k++) {
            str text = str_c(AMGI_STARTER_PHRASES[c].phrases[k]);
            const char *name = str_z(&a, amgi_media_name(&a, text, code, "mp3"));
            char shipped_path[PATH_MAX];
            snprintf(shipped_path, sizeof shipped_path, "%s/%s", media, name);
            if (!exists(shipped_path)) continue; /* a clip this folder does not ship has no row */
            int converted = 0;
            for (size_t i = 0; i < nclips && !converted; i++)
                converted = clips[i].wanted && !strcmp(str_z(&a, clips[i].name), name);
            sa_take *t = converted ? take_of(takes, ntakes, name) : NULL;
            const char *row = converted ? NULL : manifest_row(manifest_lines, nmanifest, name);
            if (t) buf_fmt(&out, "%s\t%s\t%s\t%s\t%d\t%.*s\n", name, t->language, t->model, t->voice, t->attempts, (int)text.n, text.p);
            else if (row) buf_fmt(&out, "%s\n", row);
            else buf_fmt(&out, "%s\t%s\tunknown\tunknown\t\t%.*s\n", name, AMGI_STARTER_PHRASES[c].code, (int)text.n, text.p);
        }
    }
    int bad_write = write_whole(manifest, out.p, out.n);
    buf_free(&out);
    if (bad_write) return ar_free(&a), RC_FAIL;
    printf("converted %zu clip(s) to mp3 at %s; wrote %s\n", nwanted, MP3_BITRATE, manifest);
    return ar_free(&a), RC_OK;
}
