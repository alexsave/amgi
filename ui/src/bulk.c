/* BulkRun: the lines being made into cards, one row each, five at a time. Each line asks for its
 * card's text and clips (POST /card-text); Gemini's limits come back as 429s, which the row waits
 * out with a countdown (notStarted: nothing was spent, wait and ask again; started: wait, within
 * the card's budget, the server's maxWaitMs; dailyCap: the day is spent, every line still to go
 * stops). Finished cards are written in batches (ten, or every three seconds) so closing the tab
 * cannot cost more than a few, and the deck is refreshed once at the end. */
#include "app.h"

enum { QUEUED, MAKING, WAITING, DONE, SKIPPED, BROKEN };
enum { T_KEYS = 1, T_LINE, T_WRITE };
enum { TM_WAIT = 1, TM_TICK, TM_FLUSH };
#define CONCURRENCY 5
#define FLUSH_SIZE 10
#define FLUSH_MS 3000

typedef struct {
  text line, cue, target, cue_clip, target_clip, cue_ref, target_ref, error;
  uint32_t status, wait_left, budget_ms;
  int same_both, retrying;
  int64_t note_id;
  cd_region view;
  int32_t chips[2];
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
static uint32_t next_pending, active, counting;
static uint32_t *buffered, nbuffered;   /* rows finished and not written yet */
static uint32_t **batches, *batch_n, nbatches, batch_head; /* written one at a time, in order */
static int writing, flush_armed;
static cd_id list, head;
static cd_region view = {0}, head_view = {0};
static holder h;
static void (*finished)(void);

static uint32_t token(uint32_t kind, uint32_t i) { return (run & 0xf) << 20 | kind << 16 | (i & 0xffff); }

static const char *const STATUS_LABEL[] = {"queued", "making…", "rate limited", "in the deck", "already here", "failed"};

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
  if (r->status == WAITING || r->wait_left > 0) {
    uint32_t n = 0;
    if (r->wait_left > 0) {
      n = catz(d, 0, r->status == WAITING ? "rate limited, retrying in " : "waiting for rate limit, retrying in ");
      n = catn(d, n, r->wait_left);
      return catz(d, n, "s…");
    }
    return r->status == WAITING ? catz(d, 0, "rate limited, retrying…") : 0;
  }
  if (r->same_both) return catz(d, 0, "both sides came back the same - open it and fix the wording");
  return cat(d, 0, r->cue.p ? r->cue.p : "", r->cue.len);
}

static void head_draw(void) {
  cd_region_hide(&head_view);
  if (!shown || !cd_region_show(&head_view, 1)) return;
  cd_at(head, 0);
  uint32_t done = 0, skipped = 0, failed = 0, waiting = 0;
  for (uint32_t i = 0; i < nrows; i++) {
    done += rows[i].status == DONE;
    skipped += rows[i].status == SKIPPED;
    failed += rows[i].status == BROKEN;
    waiting += rows[i].status == WAITING || rows[i].wait_left > 0;
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
  for (int s = 0; s < 2; s++) {
    chip_forget(r->chips[s]);
    r->chips[s] = -1;
  }
  cd_region_hide(&r->view);
  if (!cd_region_show(&r->view, 1)) return;
  cd_id before = 0;
  for (uint32_t k = i + 1; k < nrows && !before; k++)
    if (rows[k].view.shown) before = rows[k].view.root;
  cd_at(list, before);
  cd_open(CD_LIT("li"));
  cd_name_open(r->view.root);
  switch (r->status) {
  case QUEUED: cd_class(CD_LIT("bulk-run-row is-queued")); break;
  case MAKING: cd_class(CD_LIT("bulk-run-row is-making")); break;
  case WAITING: cd_class(CD_LIT("bulk-run-row is-waiting")); break;
  case DONE: cd_class(CD_LIT("bulk-run-row is-done")); break;
  case SKIPPED: cd_class(CD_LIT("bulk-run-row is-skipped")); break;
  default: cd_class(CD_LIT("bulk-run-row is-error")); break;
  }
  el(CD_LIT("span"), CD_LIT("bulk-run-state"));
  tmp_text(STATUS_LABEL[r->status], zlen(STATUS_LABEL[r->status]));
  cd_close();
  el(CD_LIT("span"), CD_LIT("bulk-run-text"));
  const text *shown_text = r->target.len ? &r->target : &r->line;
  tmp_text(shown_text->p, shown_text->len);
  cd_close();
  char *note = cd_alloc(r->error.len + r->cue.len + 160);
  uint32_t nn = row_note(r, note);
  el(CD_LIT("span"), CD_LIT("bulk-run-cue"));
  if (nn) {
    cd_str title = CD_LIT("title");
    attr_tmp(title, note, nn);
    tmp_text(note, nn);
  }
  cd_close();
  cd_free(note);
  el(CD_LIT("span"), CD_LIT("bulk-run-clips"));
  if (r->status == BROKEN) {
    cd_id retry = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("bulk-run-retry"));
    cd_on(retry, CD_EV_CLICK, retry_pressed, CTX_OF(i));
    cd_text(CD_LIT("Retry"));
    cd_close();
  } else {
    const char *k = language_name(langs.known, zlen(langs.known)), *l = language_name(langs.learning, zlen(langs.learning));
    r->chips[0] = chip_build(r->cue_clip.p, r->cue_clip.len, k ? k : langs.known, TONE_CUE);
    r->chips[1] = chip_build(r->target_clip.p, r->target_clip.len, l ? l : langs.learning, TONE_TARGET);
  }
  cd_close();
  cd_close();
  cd_region_end(&r->view);
}

static void changed(uint32_t i) {
  row_draw(i);
  head_draw();
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
static void queue_write(uint32_t i) {
  buffered = cd_realloc(buffered, (nbuffered + 1) * sizeof *buffered);
  buffered[nbuffered++] = i;
  if (nbuffered >= FLUSH_SIZE) flush();
  else if (!flush_armed) {
    flush_armed = 1;
    timer_start(M_BULK, FLUSH_MS, token(TM_FLUSH, 0));
  }
}
static void write_next(void) {
  if (writing || batch_head >= nbatches) return;
  uint32_t *b = batches[batch_head], n = batch_n[batch_head];
  wire_q_note *notes = cd_alloc(n * sizeof *notes);
  wire_str *all = cd_alloc((n * (nt->nfields + 1)) * sizeof *all);
  for (uint32_t k = 0; k < n; k++) {
    row *r = &rows[b[k]];
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
  ask(M_BULK, token(T_WRITE, batch_head), "POST", "/notes/bulk", WK_Q_NOTES, &q);
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
    head_draw();
    refresh_decks();
    deck_reload();
    if (finished) finished();
  } else {
    refresh_decks(); /* a retry finished */
    deck_reload();
  }
}

/* ---- the lines ---- */
static void line_ask(uint32_t i) {
  row *r = &rows[i];
  r->status = MAKING;
  r->wait_left = 0;
  text_free(&r->error);
  changed(i);
  wire_q_card_text q = {{r->line.p, r->line.len}, {langs.known, zlen(langs.known)}, {langs.learning, zlen(langs.learning)}, 1};
  ask(M_BULK, token(T_LINE, i), "POST", "/card-text", WK_Q_CARD_TEXT, &q);
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
  head_draw();
}

static void tick_start(void) {
  if (counting) return;
  counting = 1;
  timer_start(M_BULK, 1000, token(TM_TICK, 0));
}

static void wait_then_ask(uint32_t i, uint32_t ms, uint32_t status) {
  row *r = &rows[i];
  r->status = status;
  r->wait_left = seconds(ms);
  changed(i);
  tick_start();
  timer_start(M_BULK, ms, token(TM_WAIT, i));
}

static void line_answer(uint32_t i, uint32_t status, const uint8_t *p, uint32_t len) {
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
    changed(i);
    queue_write(i);
    line_ended(i);
    return;
  }
  char m[700];
  uint32_t n = answer_message(&a, m, sizeof m);
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
      wait_then_ask(i, wait, QUEUED);
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

static void write_answer(uint32_t batch, uint32_t status, const uint8_t *p, uint32_t len) {
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
  head_draw();
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
  start_more();
  if (!nrows) maybe_done();
}

static void keys_answer(uint32_t status, const uint8_t *p, uint32_t len) {
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
  head_draw();
  begin();
}

static void clear_run(void) {
  for (uint32_t i = 0; i < nrows; i++) {
    row *r = &rows[i];
    for (int s = 0; s < 2; s++) chip_forget(r->chips[s]);
    cd_region_hide(&r->view);
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
  text_free(&daily_cap);
  cd_region_hide(&head_view);
  cd_region_hide(&view);
}

/* A run of lines, built after .card-form-lead in the form's box (form.c). A new run supersedes the
 * last: its answers still in flight are dropped. */
void bulk_start(cd_id form_box, int64_t deck, const notetype *type, const lang_pair *l, const wire_str *lines, uint32_t n,
                void (*on_finished)(void)) {
  clear_run();
  run++;
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
    rows[i].chips[0] = rows[i].chips[1] = -1;
    text_set(&rows[i].line, lines[i].p, lines[i].len);
  }
  if (!cd_region_show(&view, 1)) return;
  cd_at(form_box, 0);
  el(CD_LIT("div"), CD_LIT("bulk-run"));
  cd_name_open(view.root);
  head = el_id(CD_LIT("p"), CD_LIT("bulk-run-head"));
  head_view.parent = head;
  cd_close();
  list = el_id(CD_LIT("ol"), CD_LIT("bulk-run-rows"));
  cd_close();
  cd_close();
  cd_region_end(&view);
  head_draw();
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
    ask(M_BULK, token(T_KEYS, (uint32_t)k), "GET", path, WIRE_NONE, 0);
  }
}

/* The run's view goes (the form is drawn again, or the page left): nothing more is drawn, and
 * answers still in flight are dropped. */
void bulk_forget(void) {
  if (!shown) return;
  clear_run();
  shown = 0;
  run++;
}

void bulk_answer(uint32_t t, uint32_t status, const uint8_t *p, uint32_t len) {
  if (!shown || (t >> 20) != (run & 0xf)) return;
  uint32_t kind = (t >> 16) & 0xf, i = t & 0xffff;
  if (kind == T_KEYS) keys_answer(status, p, len);
  else if (kind == T_LINE && i < nrows) line_answer(i, status, p, len);
  else if (kind == T_WRITE && i < nbatches) write_answer(i, status, p, len);
}

void bulk_timer(uint32_t t) {
  if (!shown || (t >> 20) != (run & 0xf)) return;
  uint32_t kind = (t >> 16) & 0xf, i = t & 0xffff;
  if (kind == TM_WAIT && i < nrows) {
    if (daily_cap.len) { /* the day ran out while this line waited */
      rows[i].status = BROKEN;
      rows[i].wait_left = 0;
      text_set(&rows[i].error, daily_cap.p, daily_cap.len);
      changed(i);
      line_ended(i);
      return;
    }
    line_ask(i);
  } else if (kind == TM_FLUSH) {
    flush_armed = 0;
    flush();
  } else if (kind == TM_TICK) {
    /* the countdown on waiting rows: a display of the wait each row was given */
    counting = 0;
    int any = 0;
    for (uint32_t k = 0; k < nrows; k++) {
      if (rows[k].wait_left > 0) {
        rows[k].wait_left--;
        row_draw(k);
        any |= rows[k].wait_left > 0;
      }
    }
    head_draw();
    if (any) tick_start();
  }
}

/* ctx: the row */
ON_EVENT(retry_pressed) {
  uint32_t i = CTX_INDEX(ctx);
  if (i >= nrows || rows[i].status != BROKEN) return;
  text_free(&daily_cap);
  rows[i].retrying = 1;
  rows[i].budget_ms = 0;
  line_ask(i);
}
