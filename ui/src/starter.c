/* StarterDeck: the offer of a free sample deck on a machine with no Gemini key, below the deck list.
 * The server decides whether to offer it (GET /starter) and never sends the key, only whether one
 * exists. */
#include "app.h"


static cd_region view = {.up = &page_region};
static cd_region failure = {.up = &view}; /* p.starter-deck-error, before the note: shown while error is set */
static cd_bound cta_label, cta_off, sel_off[2];
static cd_id parent_node, known_sel, learning_sel, note_node;
static int shown, loaded, offered, busy;
static uint32_t phrase_count;
static uint32_t offered_langs; /* a bit per LANGUAGES index: the build ships clips for it */
static uint32_t known = 0, learning = 0; /* LANGUAGES indexes */
static text error;
static holder h;

static uint32_t index_of(const char *code, uint32_t len) {
    for (uint32_t i = 0; i < NLANGUAGES; i++)
        if (same_z(code, len, LANGUAGES[i].code)) return i;
    return NLANGUAGES;
}

static void option(uint32_t i, uint32_t selected) {
    cd_open("option");
    cd_attr("value", LANGUAGES[i].code);
    if (i == selected) cd_attr("selected", "");
    /* {flag(code)} {label(code)}: three text nodes */
    cd_text(LANGUAGES[i].flag);
    cd_text(" ");
    cd_text(LANGUAGES[i].name);
    cd_close();
}

ON_EVENT(language_picked);
ON_EVENT(build_pressed);

ON_ANSWER(state_answered);
ON_ANSWER(built);

ON_RENDER(draw);
ON_RENDER(patch_view);
/* draw builds the offer when what it is made of changes (the languages, the answer); patch_view sets what a press changes
 * (busy: the button's words, what is off, the failure) on the offer that is there, so a press builds nothing. */
static void dirty(void) {
    if (shown) cd_dirty(draw, 0);
}
static void dirty_patch(void) {
    if (shown) cd_dirty(patch_view, 0);
}

static int cta_is_off(void) { return busy || learning >= NLANGUAGES || learning == known; }

static void view_gone(void *ctx) {
    (void)ctx;
    cd_undirty(patch_view, 0); /* the offer it patches is gone; draw builds the next from the state as it is */
}

ON_RENDER(draw) {
    cd_region_hide(&view);
    if (!loaded || !offered || !cd_region_show(&view, 1)) return;
    cd_at(parent_node, 0);
    el("div", "starter-deck");
    cd_name_open(view.root);
    cd_on_free(0, view_gone, 0);
    el_text("h3", "starter-deck-title", "Try it without a Gemini key");
    el("p", "starter-deck-lead");
    cd_text("amgi writes and records cards with Google Gemini, and there is no key set here, so it cannot make one "
            "yet. This deck is ");
    cd_text_num(phrase_count);
    cd_text(" everyday phrases that came with amgi, already recorded in both languages - a real deck you can review, "
            "edit and delete.");
    cd_close();
    el("div", "starter-deck-pair");
    for (int which = 0; which < 2; which++) {
        el("label", "starter-deck-field");
        el_text("span", 0, which ? "I am learning" : "I know");
        cd_id sel = cd_open_id("select");
        if (busy) cd_attr("disabled", "");
        bool_bound(&sel_off[which], sel, "disabled", busy);
        cd_on(sel, CD_EV_CHANGE, language_picked, CTX_OF(which));
        if (which) learning_sel = sel;
        else known_sel = sel;
        /* in the order LANGUAGES declares, not the server's alphabetical one; learning leaves out known */
        for (uint32_t i = 0; i < NLANGUAGES; i++)
            if (offered_langs >> i & 1 && (!which || i != known)) option(i, which ? learning : known);
        cd_close();
        cd_close();
    }
    cd_close();
    cd_id cta = el_id("button", 0);
    cd_attr("type", "button");
    cd_class("starter-deck-cta");
    if (cta_is_off()) cd_attr("disabled", "");
    bool_bound(&cta_off, cta, "disabled", cta_is_off());
    cd_on(cta, CD_EV_CLICK, build_pressed, 0);
    text_bound(&cta_label, busy ? "Building the deck…" : "Make me a starter deck");
    cd_close();
    note_node = el_id("p", "starter-deck-note");
    cd_text("To make your own cards, put ");
    el_text("code", 0, "GEMINI_API_KEY=…");
    cd_text(" in ");
    el_text("code", 0, ".env.local");
    cd_text(" and restart amgi (get a key at aistudio.google.com/apikey).");
    cd_close();
    cd_close();
    cd_region_end(&view);
    dirty_patch(); /* the failure, if there is one */
}

ON_RENDER(patch_view) {
    cd_bound_set(&cta_label, busy ? "Building the deck…" : "Make me a starter deck");
    cd_bound_set_num(&cta_off, cta_is_off());
    cd_bound_set_num(&sel_off[0], busy);
    cd_bound_set_num(&sel_off[1], busy);
    cd_region_hide(&failure);
    if (!error.len || !cd_region_show(&failure, 1)) return;
    cd_at(view.root, note_node);
    el("p", "starter-deck-error");
    cd_name_open(failure.root);
    tmp_text(error.p, error.len);
    cd_close();
    cd_region_end(&failure);
}

/* Below the deck list, last in parent. Asked once a screen; drawn when the answer offers it. */
static void gone(void *ctx) {
    (void)ctx;
    shown = 0;
    cd_undirty(draw, 0);
}

void starter_show(cd_id parent) {
    if (shown) return;
    shown = 1;
    cd_on_free(&page_region, gone, 0);
    parent_node = parent;
    loaded = 0;
    busy = 0;
    text_free(&error);
    ask(state_answered, 0, "GET", "/starter", WIRE_NONE, 0);
}

/* ctx: 0 the language known, 1 the one learnt */
ON_EVENT(language_picked) {
    char code[8];
    int which = CTX_INDEX(ctx) == 1;
    uint32_t n;
    /* the options are the app's own codes: one that does not fit is no language */
    uint32_t i = cd_input_whole(which ? learning_sel : known_sel, code, sizeof code, &n) ? index_of(code, n) : NLANGUAGES;
    if (i >= NLANGUAGES) return;
    if (which) learning = i;
    else known = i;
    dirty();
}
ON_EVENT(build_pressed) {
    if (busy || learning >= NLANGUAGES || learning == known) return;
    busy = 1;
    text_free(&error);
    dirty_patch();
    static const char P[] = "amgi starter - ";
    char name[64];
    uint32_t l = zlen(LANGUAGES[learning].name);
    __builtin_memcpy(name, P, sizeof P - 1);
    __builtin_memcpy(name + sizeof P - 1, LANGUAGES[learning].name, l);
    wire_q_starter q = {{LANGUAGES[known].code, zlen(LANGUAGES[known].code)},
                        {LANGUAGES[learning].code, zlen(LANGUAGES[learning].code)},
                        {name, (uint32_t)sizeof P - 1 + l}};
    ask(built, 0, "POST", "/starter", WK_Q_STARTER, &q);
}

ON_ANSWER(state_answered) {
    wire_starter_state s;
    answer a = take(&h, WK_STARTER_STATE, status, p, len, &s);
    loaded = 1;
    offered = a.ok && s.offered;
    if (offered) {
        phrase_count = s.phrase_count;
        offered_langs = 0;
        for (uint32_t i = 0; i < s.languages.n; i++) {
            uint32_t k = index_of(s.languages.v[i].p, s.languages.v[i].len);
            if (k < NLANGUAGES) offered_langs |= 1u << k;
        }
        known = index_of("en", 2);
        /* pre-picked, so the common case is one press: the first offered language that is not English */
        learning = NLANGUAGES;
        for (uint32_t i = 0; i < NLANGUAGES && learning == NLANGUAGES; i++)
            if (offered_langs >> i & 1 && i != known) learning = i;
    }
    dirty();
}
ON_ANSWER(built) {
    wire_starter_built b;
    answer a = take(&h, WK_STARTER_BUILT, status, p, len, &b);
    if (a.ok) {
        open_after_refresh(b.deck_id);
        return;
    }
    busy = 0;
    char m[600];
    text_set(&error, m, answer_message(&a, m, sizeof m));
    dirty_patch();
}
