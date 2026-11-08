/* AudioChip: one audio control, wherever a clip can be played. Its bytes are fetched on the first
 * press (GET /media/<name>, with the settings headers, which is why it is never an <audio src>),
 * decoded once through cdom_audio and kept by filename, and played through Web Audio. Pressing one
 * chip stops whichever other chip is playing. */
#include "app.h"

enum { IDLE, LOADING, PLAYING, BROKEN };
#define CHIPS 256
typedef struct {
  int used;
  uint32_t gen;            /* bumped on every reuse, so a late answer for an old chip is dropped */
  cd_id node, bad;         /* the button; its "missing" note while broken */
  text filename, label;
  uint32_t tone, state, voice;
} chip;
static chip chips[CHIPS];

/* Decoded clips by filename, kept for the page's life: a list shows each clip once or twice. */
typedef struct { text filename; uint32_t clip; } cached;
static cached *cache;
static uint32_t ncache;

static uint32_t cached_clip(const text *f) {
  for (uint32_t i = 0; i < ncache; i++)
    if (same(cache[i].filename.p, cache[i].filename.len, f->p, f->len)) return cache[i].clip;
  return CD_AUDIO_FAILED;
}

static void title_into(chip *c) {
  if (c->state == BROKEN) {
    cd_set_attr(c->node, CD_LIT("title"), CD_LIT("That clip could not be loaded"));
    return;
  }
  char t[160];
  static const char A[] = "Play the ", B[] = " recording";
  uint32_t n = sizeof A - 1, l = c->label.len < 120 ? c->label.len : 120;
  __builtin_memcpy(t, A, n);
  __builtin_memcpy(t + n, c->label.p, l);
  n += l;
  __builtin_memcpy(t + n, B, sizeof B - 1);
  cd_str title = CD_LIT("title");
  cd_set_attr(c->node, title, cd_tmp(t, n + sizeof B - 1));
}

static cd_str class_of(const chip *c) {
  /* `audio-chip audio-chip-${tone} ${playing ? 'is-playing' : ''}`, the trailing space included */
  if (c->tone == TONE_CUE) return c->state == PLAYING ? CD_LIT("audio-chip audio-chip-cue is-playing") : CD_LIT("audio-chip audio-chip-cue ");
  return c->state == PLAYING ? CD_LIT("audio-chip audio-chip-target is-playing") : CD_LIT("audio-chip audio-chip-target ");
}

static void set_state(chip *c, uint32_t state) {
  uint32_t was = c->state;
  c->state = state;
  cd_set_class(c->node, class_of(c));
  cd_set_bool(c->node, CD_LIT("disabled"), state == LOADING);
  if ((was == BROKEN) != (state == BROKEN)) title_into(c);
  if (state == BROKEN && !c->bad) {
    cd_at(c->node, 0);
    c->bad = el_id(CD_LIT("span"), CD_LIT("audio-chip-bad"));
    cd_text(CD_LIT("missing"));
    cd_close();
  } else if (state != BROKEN && c->bad) {
    cd_remove(c->bad);
    c->bad = 0;
  }
}

ON_EVENT(pressed);
ON_ANSWER(media_answered);

int32_t chip_build(const char *filename, uint32_t flen, const char *label, uint32_t tone) {
  if (!flen) return -1;
  int32_t slot = -1;
  for (int32_t i = 0; i < CHIPS && slot < 0; i++)
    if (!chips[i].used) slot = i;
  if (slot < 0) return -1;
  chip *c = &chips[slot];
  c->used = 1;
  c->gen = (c->gen + 1) & 0xfff;
  c->tone = tone;
  c->state = IDLE;
  c->bad = 0;
  c->voice = 0;
  text_set(&c->filename, filename, flen);
  text_setz(&c->label, label);
  c->node = cd_open_id(CD_LIT("button"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(class_of(c));
  char t[160];
  static const char A[] = "Play the ", B[] = " recording";
  uint32_t n = sizeof A - 1, l = c->label.len < 120 ? c->label.len : 120;
  __builtin_memcpy(t, A, n);
  __builtin_memcpy(t + n, label, l);
  n += l;
  __builtin_memcpy(t + n, B, sizeof B - 1);
  cd_str title = CD_LIT("title");
  attr_tmp(title, t, n + sizeof B - 1);
  cd_on(c->node, CD_EV_CLICK, pressed, CTX_OF(slot));
  cd_open(CD_LIT("span"));
  cd_class(CD_LIT("audio-chip-tri"));
  cd_attr(CD_LIT("aria-hidden"), CD_LIT("true"));
  cd_close();
  el(CD_LIT("span"), CD_LIT("audio-chip-lang"));
  tmp_text(label, zlen(label));
  cd_close();
  cd_close();
  return slot;
}

cd_id chip_node(int32_t slot) { return slot >= 0 && slot < CHIPS && chips[slot].used ? chips[slot].node : 0; }

/* The chip's node went with a region: it stops, and its slot is free. Its clip stays cached. */
void chip_forget(int32_t slot) {
  if (slot < 0 || slot >= CHIPS || !chips[slot].used) return;
  chip *c = &chips[slot];
  if (c->state == PLAYING && c->voice) cd_audio_stop(c->voice);
  c->used = 0;
  c->voice = 0;
  text_free(&c->filename);
  text_free(&c->label);
}

static void play(chip *c, uint32_t clip) {
  /* one voice at a time across the page: the chip playing stops */
  for (int i = 0; i < CHIPS; i++) {
    chip *o = &chips[i];
    if (o->used && o->state == PLAYING && o->voice) {
      cd_audio_stop(o->voice);
      o->voice = 0;
      set_state(o, IDLE);
    }
  }
  c->voice = cd_audio_play(clip, 1, 1, 0);
  set_state(c, PLAYING);
}

ON_EVENT(pressed) {
  uint32_t slot = CTX_INDEX(ctx);
  if (slot >= CHIPS || !chips[slot].used) return;
  chip *c = &chips[slot];
  if (c->state == LOADING) return;
  uint32_t clip = cached_clip(&c->filename);
  if (clip != CD_AUDIO_FAILED) {
    play(c, clip);
    return;
  }
  set_state(c, LOADING);
  ask_media(media_answered, CTX_OF(c->gen << 12 | slot), c->filename.p, c->filename.len);
}

static chip *chip_of(uint32_t token) {
  uint32_t slot = token & 0xfff;
  chip *c = slot < CHIPS ? &chips[slot] : 0;
  return c && c->used && c->gen == (token >> 12) ? c : 0;
}

/* ctx: the chip's slot and generation, which the clip's decoding carries on as its token */
ON_ANSWER(media_answered) {
  uint32_t token = CTX_INDEX(ctx);
  chip *c = chip_of(token);
  if (!c) return;
  if (status != 200 || !len) {
    set_state(c, BROKEN);
    return;
  }
  cd_audio_load(token, p, len);
}

void chips_audio_loaded(uint32_t token, uint32_t clip) {
  chip *c = chip_of(token);
  if (clip == CD_AUDIO_FAILED) {
    if (c) set_state(c, BROKEN);
    return;
  }
  /* kept by filename even when its chip went meanwhile: the next press plays at once */
  if (c) {
    cache = cd_realloc(cache, (ncache + 1) * sizeof *cache);
    cache[ncache] = (cached){{0, 0}, clip};
    text_set(&cache[ncache].filename, c->filename.p, c->filename.len);
    ncache++;
    play(c, clip);
  } else {
    cd_audio_free(clip);
  }
}

void chips_audio_ended(uint32_t voice) {
  for (int i = 0; i < CHIPS; i++) {
    chip *c = &chips[i];
    if (c->used && c->voice == voice) {
      c->voice = 0;
      if (c->state == PLAYING) set_state(c, IDLE);
    }
  }
}
