/* Fill missing audio, on the deck page: one quiet line under the card count when notes of the deck lack the clip of their
 * text ("12 cards have no audio · Fill"), and nothing at all when none do. The server decides what is missing (POST
 * /decks/:id/audio-plan, asked whenever the page of notes arrives, for the deck with a pair only); Fill then asks it to fill one
 * note at a time (POST /notes/:id/audio-fill), waits out Gemini's per-minute limit with a countdown as bulk.c's rows do, and
 * can be cancelled (the note in flight still finishes). An amgi Listening note has no choices (side "both": Target and Cue
 * into their own audio fields); any other note type shows a compact picker, guessed (guess_fields) and changeable. The notes
 * the deck page shows are where the deck's note types come from. */
#include "app.h"

#define SIDE_LEARNING 0
#define SIDE_KNOWN 1

static int shown, have_pair, running, cancelled, touched;
static int64_t deck_id = -1, type_id;       /* type_id: the note type being filled (0: none yet) */
static lang_pair langs;
static int64_t *cands;                      /* the note types seen on the deck's pages */
static uint32_t ncands;
static int32_t text_f, audio_f;
static int side, form;                      /* SIDE_*; form 0 [sound:], 1 <audio> */
static int plan_valid;
static int64_t *to_fill;
static uint32_t nto_fill, plan_seq;
static uint32_t run, idx, done, failed, wait_left, tick_timer;
static text error;                          /* what the last run met, kept until the next */
static text daily_cap;
static cd_id box, sels[5];
/* The select a person just changed: every redraw builds the selects anew, so it is given focus again after each
 * draw that drew it, until the plan its change asked for has answered (a keyboard user keeps their place). */
static int32_t refocus = -1;
static int refocus_last;
static uint32_t drawn_sels; /* a bit per select this draw made */
static cd_region view = {.up = &page_region};
static holder h_plan, h_fill;

ON_RENDER(fill_draw);
ON_ANSWER(plan_answered);
ON_ANSWER(fill_answered);
ON_EVENT(fill_pressed);
ON_EVENT(cancel_pressed);
ON_EVENT(pick_changed);

static void dirty(void) {
    if (shown) cd_dirty(fill_draw, 0);
}

static const char *lang_label(const char *code) {
    const char *n = language_name(code, zlen(code));
    return n ? n : code;
}
static uint32_t cat(char *d, uint32_t n, const char *s) {
    uint32_t l = zlen(s);
    __builtin_memcpy(d + n, s, l);
    return n + l;
}
static uint32_t catn(char *d, uint32_t n, uint32_t v) { return n + cd_fmt(d + n, (int32_t)v, 0, CD_UNIT_NONE); }

static const notetype *type_now(void) { return type_id ? notetype_by_id(type_id) : 0; }
static int is_amgi(const notetype *t) { return t && same_z(t->name.p, t->name.len, AMGI_NOTETYPE_NAME); }

static int fillable(int64_t id) {
    const notetype *t = notetype_by_id(id);
    if (!t) return 0;
    field_guess g = guess_fields(t->fields, t->nfields, t->sort_field);
    return is_amgi(t) || (g.text >= 0 && g.audio >= 0);
}

/* The note type's own defaults: its guessed fields, the deck's learning language, [sound:]. 0 when it cannot be filled. */
static int choose(int64_t id) {
    const notetype *t = notetype_by_id(id);
    if (!t) return 0;
    type_id = id;
    side = SIDE_LEARNING;
    form = 0;
    text_f = audio_f = -1;
    if (is_amgi(t)) return 1;
    field_guess g = guess_fields(t->fields, t->nfields, t->sort_field);
    text_f = g.text;
    audio_f = g.audio;
    return g.text >= 0 && g.audio >= 0;
}

static void path_for(char *path, const char *pre, int64_t id, const char *tail) {
    uint32_t n = cat(path, 0, pre);
    n += id_dec(path + n, id);
    n = cat(path, n, tail);
    path[n] = 0;
}
static wire_q_fill request(int64_t deck) {
    int both = is_amgi(type_now());
    const char *s = both ? "both" : side == SIDE_KNOWN ? "known" : "learning", *f = both || form ? "html" : "sound";
    return (wire_q_fill){deck, type_id, text_f, audio_f, {s, zlen(s)}, {f, zlen(f)}};
}

static void plan_ask(void) {
    if (running || !have_pair || !type_id) return;
    plan_valid = 0;
    char path[64];
    path_for(path, "/decks/", deck_id, "/audio-plan");
    wire_q_fill q = request(deck_id);
    ask(plan_answered, CTX_OF(++plan_seq), "POST", path, WK_Q_FILL, &q);
}

/* The deck's pages brought notes (or the note types arrived): every type seen is a candidate, the first that can be filled the
 * one shown, and the plan asked again, since what a page holds is what the line counts. */
void fill_notes(const wire_notes *page) {
    if (deck_id < 0 || !have_pair || !notetypes_known) return;
    for (uint32_t i = 0; i < page->nnotes; i++) {
        int64_t id = page->notes[i].notetype_id;
        uint32_t k = 0;
        while (k < ncands && cands[k] != id) k++;
        if (k < ncands || !fillable(id)) continue;
        cands = cd_realloc(cands, (ncands + 1) * sizeof *cands);
        cands[ncands++] = id;
    }
    if (!type_id || !notetype_by_id(type_id) || !(is_amgi(type_now()) || (text_f >= 0 && audio_f >= 0))) {
        type_id = 0;
        for (uint32_t k = 0; k < ncands && !type_id; k++)
            if (!choose(cands[k])) type_id = 0;
    }
    if (type_id) plan_ask();
    else {
        plan_valid = 0;
        dirty();
    }
}

void fill_langs(const lang_pair *l) {
    langs = *l;
    have_pair = langs.known[0] != 0;
    plan_valid = 0;
    if (!have_pair) plan_seq++; /* a plan still out is for a pair that went */
    dirty();
}

ON_ANSWER(plan_answered) {
    if (CTX_INDEX(ctx) != plan_seq || running) return;
    wire_fill_plan w;
    answer a = take(&h_plan, WK_FILL_PLAN, status, p, len, &w);
    plan_valid = a.ok; /* not answered: no line, the page is as it was */
    refocus_last = 1;
    cd_free(to_fill);
    to_fill = 0;
    nto_fill = 0;
    if (a.ok) {
        to_fill = cd_alloc((w.nto_fill + 1) * sizeof *to_fill);
        for (uint32_t i = 0; i < w.nto_fill; i++) to_fill[i] = w.to_fill[i].id;
        nto_fill = w.nto_fill;
    }
    dirty();
}

/* ---- the run ---- */
static void finish(void) {
    running = 0;
    cancelled = 0;
    wait_left = 0;
    cd_timer_stop(tick_timer);
    tick_timer = 0;
    plan_valid = 0;
    run++;
    if (failed || daily_cap.len) { /* what the run could not do, said once; the line below it counts what is left */
        const text *why = daily_cap.len ? &daily_cap : &error;
        uint32_t k = why->len < 600 ? why->len : 600;
        char m[700];
        uint32_t n = catn(m, cat(m, 0, "Filled "), done);
        if (failed) n = cat(m, catn(m, cat(m, n, ", "), failed), " failed");
        n = cat(m, n, ": ");
        __builtin_memcpy(m + n, why->p, k);
        text_set(&error, m, n + k);
    }
    dirty();
    deck_reload(); /* the rows show their chips; the page of notes arriving asks the plan again */
}

static void fill_next(void) {
    if (cancelled || idx >= nto_fill || daily_cap.len) {
        finish();
        return;
    }
    char path[64];
    path_for(path, "/notes/", to_fill[idx], "/audio-fill");
    wire_q_fill q = request(deck_id);
    ask(fill_answered, CTX_OF(run), "POST", path, WK_Q_FILL, &q);
    dirty();
}

static void tick(void *ctx) {
    (void)ctx;
    tick_timer = 0;
    if (!running) return;
    if (wait_left > 1) {
        wait_left--;
        tick_timer = cd_timer_cb(1000, tick, 0);
        dirty();
        return;
    }
    wait_left = 0;
    fill_next(); /* the same note again */
}

ON_ANSWER(fill_answered) {
    if (!running || CTX_INDEX(ctx) != run) return;
    wire_note_changed c;
    answer a = take(&h_fill, WK_NOTE_CHANGED, status, p, len, &c);
    if (a.ok) {
        done++;
        idx++;
        fill_next();
        return;
    }
    if (a.err.daily_cap) {
        char m[600];
        text_set(&daily_cap, m, answer_message(&a, m, sizeof m));
        fill_next();
        return;
    }
    if (status == 429 && a.err.retry_after_ms != WIRE_NONE) {
        uint32_t s = a.err.retry_after_ms < 1000 ? 1 : (a.err.retry_after_ms + 999) / 1000;
        if (cancelled) {
            finish();
            return;
        }
        wait_left = s;
        tick_timer = cd_timer_cb(1000, tick, 0);
        dirty();
        return;
    }
    char m[600];
    text_set(&error, m, answer_message(&a, m, sizeof m));
    failed++;
    idx++;
    fill_next();
}

ON_EVENT(fill_pressed) {
    if (running || !plan_valid || !nto_fill) return;
    running = 1;
    cancelled = touched = 0; /* a run ends on no line, unless something is left to fill */
    idx = done = failed = wait_left = 0;
    text_free(&error);
    text_free(&daily_cap);
    run++;
    fill_next();
}

ON_EVENT(cancel_pressed) {
    if (!running || cancelled) return;
    cancelled = 1;
    if (wait_left) finish(); /* nothing is in flight: stop now */
    else dirty();
}

/* ctx: which select (0 note type, 1 text field, 2 audio field, 3 language, 4 form) */
ON_EVENT(pick_changed) {
    uint32_t which = CTX_INDEX(ctx), n;
    char v[24];
    if (running || which > 4 || !cd_input_whole(sels[which], v, sizeof v - 1, &n)) return;
    int64_t at = dec_id(v, n);
    const notetype *t = type_now();
    if (at < 0 || !t) return;
    touched = 1;
    refocus = (int32_t)which;
    refocus_last = 0;
    if (which == 0) {
        if ((uint32_t)at >= ncands || !choose(cands[at])) return;
        t = type_now();
    } else if (which == 1 || which == 2) {
        if ((uint32_t)at >= t->nfields) return;
        int32_t *mine = which == 1 ? &text_f : &audio_f, other = which == 1 ? audio_f : text_f;
        if ((int32_t)at == other) {
            char b[12];
            cd_set_str(sels[which], "value", cd_tmp(b, cd_fmt(b, *mine, 0, CD_UNIT_NONE)));
            return;
        }
        *mine = (int32_t)at;
    } else if (which == 3) {
        side = at ? SIDE_KNOWN : SIDE_LEARNING;
    } else {
        form = at ? 1 : 0;
    }
    plan_ask();
    dirty();
}

/* ---- the line ---- */
static void option(uint32_t value, const char *label, uint32_t len, int selected) {
    char b[12];
    cd_open("option");
    attr_tmp("value", b, cd_fmt(b, (int32_t)value, 0, CD_UNIT_NONE));
    if (selected) cd_attr("selected", "");
    tmp_text(label, len);
    cd_close();
}
static void select_open(uint32_t which, const char *label) {
    sels[which] = cd_open_id("select");
    drawn_sels |= 1u << which;
    cd_attr("aria-label", label);
    cd_on(sels[which], CD_EV_CHANGE, pick_changed, CTX_OF(which));
}

static void picker(const notetype *t) {
    el("span", "deck-langs deck-fill-pick");
    if (ncands > 1) {
        select_open(0, "Note type to fill");
        for (uint32_t k = 0; k < ncands; k++) {
            const notetype *c = notetype_by_id(cands[k]);
            if (c) option(k, c->name.p, c->name.len, cands[k] == type_id);
        }
        cd_close();
    }
    if (is_amgi(t)) { /* no choices but the type */
        cd_close();
        return;
    }
    for (int which = 1; which <= 2; which++) {
        select_open((uint32_t)which, which == 1 ? "Field to read aloud" : "Field to put the audio in");
        for (uint32_t i = 0; i < t->nfields; i++) option(i, t->fields[i].p, t->fields[i].len, (int32_t)i == (which == 1 ? text_f : audio_f));
        cd_close();
        if (which == 1) el_text("span", 0, "→");
    }
    select_open(3, "Language of the text");
    const char *lc[2] = {lang_label(langs.learning), lang_label(langs.known)};
    for (uint32_t i = 0; i < 2; i++) option(i, lc[i], zlen(lc[i]), (int)i == side);
    cd_close();
    select_open(4, "How the clip is written");
    option(0, "[sound:] tag", 12, form == 0);
    option(1, "<audio> element", 15, form == 1);
    cd_close();
    cd_close();
}

ON_RENDER(fill_draw) {
    drawn_sels = 0;
    cd_region_hide(&view);
    const notetype *t = type_now();
    int line = plan_valid && t && (nto_fill || touched);
    if (!shown || !have_pair || !(running || line || error.len) || !cd_region_show(&view, 1)) return;
    cd_at(box, 0);
    el("div", "deck-fill");
    cd_name_open(view.root);
    char m[96];
    uint32_t n;
    if (running) {
        n = catn(m, cat(m, 0, "Filling audio "), idx + 1 < nto_fill ? idx + 1 : nto_fill);
        n = catn(m, cat(m, n, " of "), nto_fill);
        el("span", "deck-fill-text");
        tmp_text(m, n);
        cd_close();
        cd_id stop = el_id("button", 0);
        cd_attr("type", "button");
        if (cancelled) cd_attr("disabled", "");
        cd_on(stop, CD_EV_CLICK, cancel_pressed, 0);
        cd_text(cancelled ? "Cancelling…" : "Cancel");
        cd_close();
        if (wait_left) {
            n = catn(m, cat(m, 0, "waiting "), wait_left);
            n = cat(m, n, "s for the rate limit");
            el("span", "deck-fill-note");
            tmp_text(m, n);
            cd_close();
        }
    } else if (line) {
        /* the dot and the button stay with the count: one nowrap piece, so a narrow line never ends on a dot */
        el("span", "deck-fill-main");
        if (nto_fill) {
            n = catn(m, 0, nto_fill);
            n = cat(m, n, nto_fill == 1 ? " card has no audio" : " cards have no audio");
            tmp_text(m, n);
            cd_text(" · ");
            cd_on(el_id("button", 0), CD_EV_CLICK, fill_pressed, 0);
            cd_attr("type", "button");
            cd_text("Fill");
            cd_close();
        } else {
            cd_text("No cards need audio with these fields");
        }
        cd_close();
        if (!is_amgi(t) || ncands > 1) picker(t);
    }
    if (error.len) {
        el("p", "deck-name-error");
        cd_attr("role", "alert");
        tmp_text(error.p, error.len);
        cd_close();
    }
    cd_close();
    cd_region_end(&view);
    if (refocus >= 0 && (drawn_sels >> refocus & 1)) cd_call(sels[refocus], "focus");
    if (refocus_last) refocus = -1, refocus_last = 0;
}

/* The page goes. The run goes with it unless the page is this deck's again (the list drawn again after a mode change). */
static void screen_gone(void *ctx) {
    (void)ctx;
    shown = 0;
    cd_undirty(fill_draw, 0);
    if (route == R_DECK && route_deck == deck_id) return;
    run++;
    plan_seq++;
    running = cancelled = 0;
    cd_timer_stop(tick_timer);
    tick_timer = 0;
    deck_id = -1;
    refocus = -1;
}

void fill_build(cd_id parent, int64_t deck, const lang_pair *l) {
    cd_on_free(0, screen_gone, 0);
    if (deck != deck_id) { /* another deck: nothing of the last is kept */
        deck_id = deck;
        ncands = 0;
        type_id = 0;
        plan_valid = touched = 0;
        nto_fill = 0;
        text_free(&error);
        text_free(&daily_cap);
    }
    box = parent;
    shown = 1;
    langs = *l;
    have_pair = langs.known[0] != 0;
    dirty();
}
