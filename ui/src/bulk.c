/* BulkRun: the lines being made into cards, one row each, five at a time, each saying the step it is at.
 * The steps before and after a card's request are the page's own (checking for duplicates, the slot, the
 * batch, the write); those inside it are the server's, polled while any card is out (GET /progress).
 * Each line asks for its card's text and clips (POST /card-text); Gemini's limits come back as 429s, which the row waits
 * out with a countdown (notStarted: nothing was spent, wait and ask again; started: wait, within
 * the card's budget, the server's maxWaitMs; dailyCap: the day is spent, every line still to go
 * stops). Finished cards are written in batches (ten, or every three seconds) so closing the tab
 * cannot cost more than a few, and the deck is refreshed once at the end. */
#include "app.h"

/* CHECKING: the deck's lines are not known yet. QUEUED: no slot yet, the page's or (wait_left) the server's.
 * MAKING: the request is out, at `step`. WAITING: Gemini's limit, until it is asked again. BATCHED: made, its
 * write not sent. SAVING: the write is out. */
enum { CHECKING, QUEUED, MAKING, WAITING, BATCHED, SAVING, DONE, SKIPPED, BROKEN };
#define CONCURRENCY 5
#define FLUSH_SIZE 10
#define FLUSH_MS 3000
#define POLL_FIRST_MS 50 /* a card just asked for: its first step, soon */
#define POLL_MS 250      /* from one progress answer to the next question, so never two out */

typedef struct {
  text line, cue, target, cue_clip, target_clip, cue_ref, target_ref, error;
  uint32_t status, wait_left, budget_ms;
  uint32_t progress_id;              /* this request's, new each time the line is asked */
  uint32_t step, step_take, step_takes; /* what the server last said of it (WP_*) */
  uint32_t step_wait;                /* seconds left of the server's own wait on Gemini's limit */
  uint32_t wait_timer;               /* the wait before asking again (cd_timer_cb's token, 0: none yet) */
  int same_both, retrying;
  int64_t note_id;
  cd_region view;                    /* in the run's view; its chips go with it */
} row;

static row *rows;
static uint32_t nrows, run;          /* run: bumped by every new run, so a late answer is dropped */
static int64_t deck_id;
static const notetype *nt;
static amgi_fields idx;
static lang_pair langs;
static int running, shown, keys_left;
static text daily_cap;               /* the day's cap message, once hit */
static text *keys;                   /* the deck's dedupe keys */
static uint32_t nkeys;
static uint32_t next_pending, active;
static uint32_t tick_timer, flush_timer; /* the countdown's next second, the write of what is buffered (0: none) */
static uint32_t *buffered, nbuffered;   /* rows finished and not written yet */
static uint32_t **batches, *batch_n, nbatches, batch_head; /* written one at a time, in order */
static int writing;
static cd_id list, head;
static cd_region view = {.up = &page_region}, head_view = {.up = &view};
static holder h;
static void (*finished)(void);
static cd_timer_slot poll_timer;
static int poll_out;
static uint32_t last_progress_id;    /* from one draw a page, so two tabs' cards do not share a number */

/* A request's ctx: the run that asked and the row or batch it is for. A request cannot be taken
 * back, so an answer for a run that is over (a later run, or the view gone) is dropped by its run. */
static void *asked(uint32_t i) { return CTX_OF((run & 0xffff) << 16 | (i & 0xffff)); }
static int current(void *ctx, uint32_t *i) {
  *i = CTX_INDEX(ctx) & 0xffff;
  return shown && CTX_INDEX(ctx) >> 16 == (run & 0xffff);
}
ON_ANSWER(keys_answered);
ON_ANSWER(line_answered);
ON_ANSWER(write_answered);
ON_ANSWER(progress_answered);

static const char *const STATUS_LABEL[] = {
  [CHECKING] = "checking for duplicates",
  [QUEUED] = "waiting for slot",
  [MAKING] = "waiting for slot", /* asked, and the server has not started it (WP_NONE) */
  [WAITING] = "waiting for rate limit",
  [BATCHED] = "waiting for batch",
  [SAVING] = "writing to Anki",
  [DONE] = "in the deck",
  [SKIPPED] = "already here",
  [BROKEN] = "failed",
};
static const char *const STEP_LABEL[] = {
  [WP_WRITING] = "writing both sides",
  [WP_TARGET_REUSE] = "checking target reuse",
  [WP_TARGET_RECORDING] = "recording target",
  [WP_TARGET_TRANSCRIBING] = "transcribing target",
  [WP_TARGET_JUDGING] = "judging target",
  [WP_TARGET_STORING] = "storing target",
  [WP_CUE_REUSE] = "checking cue reuse",
  [WP_CUE_RECORDING] = "recording cue",
  [WP_CUE_TRANSCRIBING] = "transcribing cue",
  [WP_CUE_JUDGING] = "judging cue",
  [WP_CUE_STORING] = "storing cue",
};
_Static_assert(sizeof STEP_LABEL / sizeof *STEP_LABEL == WP_STEPS, "every step the server names has its words");

static int rate_limited(const row *r) { return r->status == WAITING || (r->status == MAKING && r->step_wait); }
static const char *state_label(const row *r) {
  if (rate_limited(r)) return STATUS_LABEL[WAITING];
  return r->status == MAKING && r->step ? STEP_LABEL[r->step] : STATUS_LABEL[r->status];
}

static uint32_t seconds(uint32_t ms) { return ms < 1000 ? 1 : (ms + 999) / 1000; }

static uint32_t cat(char *d, uint32_t n, const char *s, uint32_t l) {
  __builtin_memcpy(d + n, s, l);
  return n + l;
}
static uint32_t catz(char *d, uint32_t n, const char *s) { return cat(d, n, s, zlen(s)); }
static uint32_t catn(char *d, uint32_t n, uint32_t v) { return n + cd_fmt(d + n, (int32_t)v, 0, CD_UNIT_NONE); }

/* What a row says on its right, in the order a person needs it (BulkRun's rowNote). */
static uint32_t row_note(const row *r, char *d) {
  if (r->status == BROKEN) return cat(d, 0, r->error.p ? r->error.p : "", r->error.len);
  if (r->status == WAITING || r->wait_left > 0) { /* asked again when it is over */
    if (!r->wait_left) return catz(d, 0, "retrying…");
    return catz(d, catn(d, catz(d, 0, "retrying in "), r->wait_left), "s…");
  }
  if (rate_limited(r)) return catz(d, catn(d, catz(d, 0, "continuing in "), r->step_wait), "s…");
  if (r->same_both) return catz(d, 0, "both sides came back the same - open it and fix the wording");
  return cat(d, 0, r->cue.p ? r->cue.p : "", r->cue.len);
}

ON_RENDER(head_draw);

/* The rows stay direct calls (row_draw): they are list rows, and a list's rows are not renders. */
static void dirty_head(void) {
  if (shown) cd_dirty(head_draw, 0);
}

ON_RENDER(head_draw) {
  cd_region_hide(&head_view);
  if (!cd_region_show(&head_view, 1)) return;
  cd_at(head, 0);
  uint32_t done = 0, skipped = 0, failed = 0, waiting = 0;
  for (uint32_t i = 0; i < nrows; i++) {
    done += rows[i].status == DONE;
    skipped += rows[i].status == SKIPPED;
    failed += rows[i].status == BROKEN;
    waiting += rate_limited(&rows[i]);
  }
  char t[96];
  uint32_t n;
  if (running) {
    n = catn(t, catz(t, 0, "Making "), nrows);
    n = catz(t, n, nrows == 1 ? " card…" : " cards…");
  } else {
    n = catn(t, catz(t, 0, "Done: "), done);
    n = catz(t, n, " added");
  }
  tmp_text(t, n);
  if (running && waiting) {
    n = catz(t, catn(t, catz(t, 0, ", "), waiting), " waiting for the rate limit");
    tmp_text(t, n);
  }
  if (!running && skipped) {
    n = catz(t, catn(t, catz(t, 0, ", "), skipped), " already in the deck");
    tmp_text(t, n);
  }
  if (!running && failed) {
    n = catz(t, catn(t, catz(t, 0, ", "), failed), " failed");
    tmp_text(t, n);
  }
  cd_region_end(&head_view);
}

ON_EVENT(retry_pressed);

static void row_draw(uint32_t i) {
  if (!shown) return;
  row *r = &rows[i];
  cd_region_hide(&r->view);
  if (!cd_region_show(&r->view, 1)) return;
  cd_id before = 0;
  for (uint32_t k = i + 1; k < nrows && !before; k++)
    if (rows[k].view.shown) before = rows[k].view.root;
  cd_at(list, before);
  cd_open("li");
  cd_name_open(r->view.root);
  switch (rate_limited(r) ? WAITING : r->status) {
  case CHECKING:
  case QUEUED: cd_class("bulk-run-row is-queued"); break;
  case MAKING:
  case BATCHED:
  case SAVING: cd_class("bulk-run-row is-making"); break;
  case WAITING: cd_class("bulk-run-row is-waiting"); break;
  case DONE: cd_class("bulk-run-row is-done"); break;
  case SKIPPED: cd_class("bulk-run-row is-skipped"); break;
  default: cd_class("bulk-run-row is-error"); break;
  }
  el("span", "bulk-run-state");
  cd_text(state_label(r));
  if (r->status == MAKING && !r->step_wait && r->step_take > 1) {
    el("span", "bulk-run-take");
    cd_text("take ");
    cd_text_num(r->step_take);
    cd_text(" of ");
    cd_text_num(r->step_takes);
    cd_close();
  }
  cd_close();
  el("span", "bulk-run-text");
  const text *shown_text = r->target.len ? &r->target : &r->line;
  tmp_text(shown_text->p, shown_text->len);
  cd_close();
  char *note = cd_alloc(r->error.len + r->cue.len + 160);
  uint32_t nn = row_note(r, note);
  el("span", "bulk-run-cue");
  if (nn) {
    attr_tmp("title", note, nn);
    tmp_text(note, nn);
  }
  cd_close();
  cd_free(note);
  el("span", "bulk-run-clips");
  if (r->status == BROKEN) {
    cd_id retry = el_id("button", 0);
    cd_attr("type", "button");
    cd_class("bulk-run-retry");
    cd_on(retry, CD_EV_CLICK, retry_pressed, CTX_OF(i));
    cd_text("Retry");
    cd_close();
  } else {
    const char *k = language_name(langs.known, zlen(langs.known)), *l = language_name(langs.learning, zlen(langs.learning));
    chip_build(0, r->cue_clip.p, r->cue_clip.len, k ? k : langs.known, TONE_CUE);
    chip_build(0, r->target_clip.p, r->target_clip.len, l ? l : langs.learning, TONE_TARGET);
  }
  cd_close();
  cd_close();
  cd_region_end(&r->view);
}

static void changed(uint32_t i) {
  row_draw(i);
  dirty_head();
}

/* ---- writing ---- */
static void write_next(void);
static void flush(void) {
  if (!nbuffered) return;
  batches = cd_realloc(batches, (nbatches + 1) * sizeof *batches);
  batch_n = cd_realloc(batch_n, (nbatches + 1) * sizeof *batch_n);
  batches[nbatches] = buffered;
  batch_n[nbatches] = nbuffered;
  nbatches++;
  buffered = 0;
  nbuffered = 0;
  write_next();
}
static void flush_due(void *ctx) {
  (void)ctx;
  flush_timer = 0;
  flush();
}
static void queue_write(uint32_t i) {
  buffered = cd_realloc(buffered, (nbuffered + 1) * sizeof *buffered);
  buffered[nbuffered++] = i;
  if (nbuffered >= FLUSH_SIZE) flush();
  else if (!flush_timer) flush_timer = cd_timer_cb(FLUSH_MS, flush_due, 0);
}
static void write_next(void) {
  if (writing || batch_head >= nbatches) return;
  uint32_t *b = batches[batch_head], n = batch_n[batch_head];
  wire_q_note *notes = cd_alloc(n * sizeof *notes);
  wire_str *all = cd_alloc((n * (nt->nfields + 1)) * sizeof *all);
  for (uint32_t k = 0; k < n; k++) {
    row *r = &rows[b[k]];
    r->status = SAVING;
    row_draw(b[k]);
    wire_str *f = all + k * (nt->nfields + 1);
    for (uint32_t j = 0; j < nt->nfields; j++) f[j] = (wire_str){"", 0};
    if (idx.cue >= 0) f[idx.cue] = (wire_str){r->cue.p, r->cue.len};
    if (idx.target >= 0) f[idx.target] = (wire_str){r->target.p, r->target.len};
    if (idx.target_audio >= 0) f[idx.target_audio] = (wire_str){r->target_ref.p ? r->target_ref.p : "", r->target_ref.len};
    if (idx.cue_audio >= 0) f[idx.cue_audio] = (wire_str){r->cue_ref.p ? r->cue_ref.p : "", r->cue_ref.len};
    if (idx.language >= 0) f[idx.language] = (wire_str){langs.learning, zlen(langs.learning)};
    notes[k] = (wire_q_note){deck_id, nt->id, {f, nt->nfields}, {0, 0}, {langs.learning, zlen(langs.learning)},
                             idx.target >= 0 ? idx.target : WIRE_ABSENT};
  }
  wire_q_notes q = {notes, n};
  writing = 1;
  ask(write_answered, asked(batch_head), "POST", "/notes/bulk", WK_Q_NOTES, &q);
  cd_free(all);
  cd_free(notes);
}

/* The run is over when every line ended and every card is written: the deck once, then the form. */
static void maybe_done(void) {
  if (next_pending < nrows || active || nbuffered || writing || batch_head < nbatches) return;
  int retried = 0;
  for (uint32_t i = 0; i < nrows; i++) retried |= rows[i].retrying;
  if (retried) return;
  if (running) {
    running = 0;
    dirty_head();
    refresh_decks();
    deck_reload();
    if (finished) finished();
  } else {
    refresh_decks(); /* a retry finished */
    deck_reload();
  }
}

/* ---- the steps inside a card's request ---- */
static void poll(void *ctx) {
  (void)ctx;
  if (poll_out) return;
  for (uint32_t i = 0; i < nrows; i++)
    if (rows[i].status == MAKING) {
      poll_out = 1;
      ask(progress_answered, asked(0), "GET", "/progress", WIRE_NONE, 0);
      return;
    }
}

ON_ANSWER(progress_answered) {
  uint32_t unused;
  if (!current(ctx, &unused)) return;
  poll_out = 0;
  wire_progress w;
  answer a = take(&h, WK_PROGRESS, status, p, len, &w);
  if (a.ok) {
    for (uint32_t i = 0; i < nrows; i++) {
      row *r = &rows[i];
      if (r->status != MAKING) continue; /* it answered while this was out */
      for (uint32_t k = 0; k < w.ncards; k++) {
        const wire_card_progress *c = &w.cards[k];
        if (c->id != r->progress_id || c->step >= WP_STEPS) continue;
        uint32_t wait = c->wait_ms ? seconds(c->wait_ms) : 0;
        int written = c->back_text.len && !r->target.len;
        if (c->step == r->step && c->take == r->step_take && wait == r->step_wait && !written) break;
        r->step = c->step;
        r->step_take = c->take;
        r->step_takes = c->takes;
        r->step_wait = wait;
        if (written) {
          text_set(&r->cue, c->front_text.p, c->front_text.len);
          text_set(&r->target, c->back_text.p, c->back_text.len);
        }
        changed(i);
        break;
      }
    }
  } /* not answered: the rows keep the step they last heard */
  cd_timer_set(&poll_timer, POLL_MS, poll, 0);
}

/* ---- the lines ---- */
/* What the line's last request made or said goes: the sides and the step. */
static void attempt_forget(row *r) {
  text *made[] = {&r->cue, &r->target, &r->cue_clip, &r->target_clip, &r->cue_ref, &r->target_ref};
  for (uint32_t k = 0; k < sizeof made / sizeof *made; k++) text_free(made[k]);
  r->step = r->step_take = r->step_takes = r->step_wait = 0;
  r->same_both = 0;
}
static void line_ask(uint32_t i) {
  row *r = &rows[i];
  attempt_forget(r);
  r->status = MAKING;
  r->wait_left = 0;
  if (!last_progress_id) last_progress_id = cd_rand();
  if (!++last_progress_id) last_progress_id = 1; /* 0 names no card */
  r->progress_id = last_progress_id;
  text_free(&r->error);
  changed(i);
  wire_q_card_text q = {{r->line.p, r->line.len}, deck_id, 1, r->progress_id};
  ask(line_answered, asked(i), "POST", "/card-text", WK_Q_CARD_TEXT, &q);
  if (!poll_out) cd_timer_set(&poll_timer, POLL_FIRST_MS, poll, 0);
}

static void start_more(void);
static void line_ended(uint32_t i) {
  if (rows[i].retrying) {
    rows[i].retrying = 0;
    flush();
  } else if (active) {
    active--;
  }
  start_more();
  if (next_pending >= nrows && !active) flush();
  maybe_done();
}

static void start_more(void) {
  while (active < CONCURRENCY && next_pending < nrows) {
    uint32_t i = next_pending++;
    if (rows[i].status != QUEUED) continue; /* skipped, or ended by the daily cap */
    if (daily_cap.len) continue;
    active++;
    line_ask(i);
  }
}

static void stop_for_daily_cap(uint32_t i, const char *m, uint32_t n) {
  text_set(&daily_cap, m, n);
  for (uint32_t k = 0; k < nrows; k++) {
    row *r = &rows[k];
    if (k == i || r->status == QUEUED || r->status == WAITING) {
      r->status = BROKEN;
      r->wait_left = 0;
      text_set(&r->error, m, n);
      row_draw(k);
    }
  }
  dirty_head();
}

/* The countdown on waiting rows, a second at a time: a display of the wait each row was given. */
static void tick(void *ctx);
static void tick_start(void) {
  if (!tick_timer) tick_timer = cd_timer_cb(1000, tick, 0);
}
static void tick(void *ctx) {
  (void)ctx;
  tick_timer = 0;
  int any = 0;
  for (uint32_t k = 0; k < nrows; k++) {
    if (rows[k].wait_left > 0) {
      rows[k].wait_left--;
      row_draw(k);
      any |= rows[k].wait_left > 0;
    }
  }
  dirty_head();
  if (any) tick_start();
}

/* ctx: the row; its wait is over */
static void wait_over(void *ctx) {
  uint32_t i = CTX_INDEX(ctx);
  if (i >= nrows) return;
  rows[i].wait_timer = 0;
  if (daily_cap.len) { /* the day ran out while this line waited */
    rows[i].status = BROKEN;
    rows[i].wait_left = 0;
    text_set(&rows[i].error, daily_cap.p, daily_cap.len);
    changed(i);
    line_ended(i);
    return;
  }
  line_ask(i);
}

static void wait_then_ask(uint32_t i, uint32_t ms, uint32_t status) {
  row *r = &rows[i];
  r->status = status;
  r->wait_left = seconds(ms);
  changed(i);
  tick_start();
  r->wait_timer = cd_timer_cb(ms, wait_over, CTX_OF(i));
}

ON_ANSWER(line_answered) {
  uint32_t i;
  if (!current(ctx, &i) || i >= nrows) return;
  row *r = &rows[i];
  wire_card_text c;
  answer a = take(&h, WK_CARD_TEXT, status, p, len, &c);
  if (a.ok) {
    text_set(&r->cue, c.front_text.p, c.front_text.len);
    text_set(&r->target, c.back_text.p, c.back_text.len);
    text_set(&r->cue_clip, c.cue_audio.filename.p, c.cue_audio.filename.len);
    text_set(&r->target_clip, c.audio.filename.p, c.audio.filename.len);
    text_set(&r->cue_ref, c.cue_audio.reference.p, c.cue_audio.reference.len);
    text_set(&r->target_ref, c.audio.reference.p, c.audio.reference.len);
    wire_str f = trim(c.front_text), b = trim(c.back_text);
    r->same_both = same(f.p, f.len, b.p, b.len);
    r->status = BATCHED;
    r->step_wait = 0;
    changed(i);
    queue_write(i);
    line_ended(i);
    return;
  }
  char m[700];
  uint32_t n = answer_message(&a, m, sizeof m);
  attempt_forget(r); /* it made no card: the row is the typed line again */
  if (a.err.daily_cap) {
    stop_for_daily_cap(i, m, n);
    line_ended(i);
    return;
  }
  if (daily_cap.len) {
    r->status = BROKEN;
    r->wait_left = 0;
    text_set(&r->error, daily_cap.p, daily_cap.len);
    changed(i);
    line_ended(i);
    return;
  }
  if (status == 429 && a.err.retry_after_ms != WIRE_NONE) {
    uint32_t wait = a.err.retry_after_ms;
    if (a.err.not_started) {
      wait_then_ask(i, wait, same_z(a.err.error.p, a.err.error.len, WIRE_NO_SLOT_ERROR) ? QUEUED : WAITING);
      return;
    }
    uint32_t budget = a.err.max_wait_ms;
    if (budget != WIRE_NONE && r->budget_ms + wait > budget) {
      uint32_t k = catz(m, 0, "Gave up on Gemini's rate limit: this line already waited ");
      k = catn(m, k, (r->budget_ms + 500) / 1000);
      k = catz(m, k, "s, and another ");
      k = catn(m, k, seconds(wait));
      k = catz(m, k, "s would pass its ");
      k = catn(m, k, budget / 1000);
      k = catz(m, k, "s limit. Press Retry to try again.");
      r->status = BROKEN;
      r->wait_left = 0;
      text_set(&r->error, m, k);
      changed(i);
      line_ended(i);
      return;
    }
    r->budget_ms += wait;
    wait_then_ask(i, wait, WAITING);
    return;
  }
  r->status = BROKEN;
  r->wait_left = 0;
  text_set(&r->error, m, n);
  changed(i);
  line_ended(i);
}

ON_ANSWER(write_answered) {
  uint32_t batch;
  if (!current(ctx, &batch) || batch >= nbatches) return;
  wire_notes_added w;
  answer a = take(&h, WK_NOTES_ADDED, status, p, len, &w);
  uint32_t *b = batches[batch], n = batch_n[batch];
  char m[600];
  uint32_t mn = a.ok ? 0 : answer_message(&a, m, sizeof m);
  for (uint32_t k = 0; k < n; k++) {
    row *r = &rows[b[k]];
    if (!a.ok) {
      r->status = BROKEN;
      text_set(&r->error, m, mn);
    } else if (k < w.nresults && !w.results[k].ok) {
      r->status = BROKEN;
      text_set(&r->error, w.results[k].error.p, w.results[k].error.len);
    } else {
      r->status = DONE;
      r->note_id = k < w.nresults ? w.results[k].note_id : 0;
    }
    row_draw(b[k]);
  }
  dirty_head();
  cd_free(b);
  batches[batch] = 0;
  batch_head = batch + 1;
  writing = 0;
  write_next();
  maybe_done();
}

/* ---- the run ---- */
static void begin(void) {
  next_pending = 0;
  for (uint32_t i = 0; i < nrows; i++)
    if (rows[i].status == CHECKING) {
      rows[i].status = QUEUED;
      row_draw(i);
    }
  start_more();
  if (!nrows) maybe_done();
}

ON_ANSWER(keys_answered) {
  uint32_t field;
  if (!current(ctx, &field)) return;
  wire_field_values v;
  answer a = take(&h, WK_FIELD_VALUES, status, p, len, &v);
  if (a.ok) {
    keys = cd_realloc(keys, (nkeys + v.values.n + 1) * sizeof *keys);
    for (uint32_t k = 0; k < v.values.n; k++) {
      char *buf = cd_alloc(v.values.v[k].len + 1);
      keys[nkeys] = (text){0, 0};
      text_set(&keys[nkeys], buf, dedupe_key(buf, v.values.v[k]));
      cd_free(buf);
      nkeys++;
    }
  } /* not answered: nothing is known to be there, and every line is made */
  if (--keys_left) return;
  for (uint32_t i = 0; i < nrows; i++) {
    char *buf = cd_alloc(rows[i].line.len + 1);
    uint32_t kn = dedupe_key(buf, (wire_str){rows[i].line.p, rows[i].line.len});
    for (uint32_t k = 0; k < nkeys; k++)
      if (same(keys[k].p, keys[k].len, buf, kn)) {
        rows[i].status = SKIPPED;
        row_draw(i);
        break;
      }
    cd_free(buf);
  }
  dirty_head();
  begin();
}

/* The run's view goes (a new run, the form drawn again, or the page left): the one place the run's state
 * goes, its timers stopped with it. Nothing more is drawn, and the answers still in flight are dropped by
 * their run. The rows' views, the head's and their chips are the view's children, and are gone before this. */
static void run_gone(void *ctx) {
  (void)ctx;
  for (uint32_t i = 0; i < nrows; i++) {
    row *r = &rows[i];
    cd_timer_stop(r->wait_timer);
    text *ts[] = {&r->line, &r->cue, &r->target, &r->cue_clip, &r->target_clip, &r->cue_ref, &r->target_ref, &r->error};
    for (uint32_t k = 0; k < sizeof ts / sizeof *ts; k++) text_free(ts[k]);
  }
  cd_free(rows);
  rows = 0;
  nrows = 0;
  for (uint32_t k = 0; k < nkeys; k++) text_free(&keys[k]);
  nkeys = 0;
  for (uint32_t k = batch_head; k < nbatches; k++) cd_free(batches[k]);
  nbatches = batch_head = 0;
  cd_free(buffered);
  buffered = 0;
  nbuffered = 0;
  writing = active = 0;
  cd_timer_stop(tick_timer);
  cd_timer_stop(flush_timer);
  cd_timer_clear(&poll_timer);
  poll_out = 0; /* its answer, if one is out, is another run's and is dropped */
  tick_timer = flush_timer = 0;
  text_free(&daily_cap);
  shown = 0;
  cd_undirty(head_draw, 0);
  run++;
}

/* A run of lines, built after .card-form-lead in the form's box (form.c). A new run supersedes the
 * last: its answers still in flight are dropped. */
void bulk_start(cd_id form_box, int64_t deck, const notetype *type, const lang_pair *l, const wire_str *lines, uint32_t n,
                void (*on_finished)(void)) {
  bulk_discard();
  shown = 1;
  running = 1;
  deck_id = deck;
  nt = type;
  langs = *l;
  finished = on_finished;
  idx = amgi_fields_of(type->fields, type->nfields);
  rows = cd_alloc((n ? n : 1) * sizeof *rows);
  nrows = n;
  for (uint32_t i = 0; i < n; i++) {
    __builtin_memset(&rows[i], 0, sizeof rows[i]);
    rows[i].status = CHECKING;
    rows[i].view.up = &view;
    text_set(&rows[i].line, lines[i].p, lines[i].len);
  }
  if (!cd_region_show(&view, 1)) return;
  cd_on_free(0, run_gone, 0);
  cd_at(form_box, 0);
  el("div", "bulk-run");
  cd_name_open(view.root);
  head = el_id("p", "bulk-run-head");
  head_view.parent = head;
  cd_close();
  list = el_id("ol", "bulk-run-rows");
  cd_close();
  cd_close();
  cd_region_end(&view);
  dirty_head();
  for (uint32_t i = 0; i < n; i++) row_draw(i);
  /* the deck's own lines first: a line already a card is not made again */
  keys_left = 0;
  int32_t fields[2] = {idx.cue, idx.target};
  for (int k = 0; k < 2; k++)
    if (fields[k] >= 0) keys_left++;
  if (!keys_left) {
    begin();
    return;
  }
  for (int k = 0; k < 2; k++) {
    if (fields[k] < 0) continue;
    char path[160] = "/decks/";
    uint32_t pn = 7 + id_dec(path + 7, deck);
    pn = catz(path, pn, "/notes/field-values?notetypeId=");
    pn += id_dec(path + pn, type->id);
    pn = catz(path, pn, "&fieldIndex=");
    pn = catn(path, pn, (uint32_t)fields[k]);
    path[pn] = 0;
    ask(keys_answered, asked((uint32_t)k), "GET", path, WIRE_NONE, 0);
  }
}

void bulk_discard(void) { cd_region_hide(&view); }

/* ctx: the row */
ON_EVENT(retry_pressed) {
  uint32_t i = CTX_INDEX(ctx);
  if (i >= nrows || rows[i].status != BROKEN) return;
  text_free(&daily_cap);
  rows[i].retrying = 1;
  rows[i].budget_ms = 0;
  line_ask(i);
}
