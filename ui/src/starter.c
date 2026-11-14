/* StarterDeck: the offer of a free sample deck on a machine with no Gemini key, below the deck list.
 * The server decides whether to offer it (GET /starter) and never sends the key, only whether one
 * exists. */
#include "app.h"


static cd_region view = {.up = &page_region};
static cd_region failure = {.up = &view}; /* p.starter-deck-error, before the note: shown while error is set */
/* What the button says and whether it and the two selects are off: set by patch_view, written only when changed. */
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
  cd_open(CD_LIT("option"));
  cd_attr(CD_LIT("value"), cd_internz(LANGUAGES[i].code));
  if (i == selected) cd_attr(CD_LIT("selected"), CD_LIT(""));
  /* {flag(code)} {label(code)}: three text nodes */
  cd_text(cd_internz(LANGUAGES[i].flag));
  cd_text(CD_LIT(" "));
  cd_text(cd_internz(LANGUAGES[i].name));
  cd_close();
}

ON_EVENT(language_picked);
ON_EVENT(build_pressed);

ON_ANSWER(state_answered);
ON_ANSWER(built);

/* The view is a render. Two guards, for two vectors: dirty() asks only while the screen shows it, which covers an ask
 * made after the screen went (a late answer); the cd_undirty in gone covers an ask made earlier in the same entry. */
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
  el(CD_LIT("div"), CD_LIT("starter-deck"));
  cd_name_open(view.root);
  cd_on_free(0, view_gone, 0);
  el_text(CD_LIT("h3"), CD_LIT("starter-deck-title"), CD_LIT("Try it without a Gemini key"));
  el(CD_LIT("p"), CD_LIT("starter-deck-lead"));
  cd_text(CD_LIT("amgi writes and records cards with Google Gemini, and there is no key set here, so it cannot make one "
                 "yet. This deck is "));
  cd_text_num(phrase_count);
  cd_text(CD_LIT(" everyday phrases that came with amgi, already recorded in both languages - a real deck you can review, "
                 "edit and delete."));
  cd_close();
  el(CD_LIT("div"), CD_LIT("starter-deck-pair"));
  for (int which = 0; which < 2; which++) {
    el(CD_LIT("label"), CD_LIT("starter-deck-field"));
    el_text(CD_LIT("span"), 0, which ? CD_LIT("I am learning") : CD_LIT("I know"));
    cd_id sel = cd_open_id(CD_LIT("select"));
    if (busy) cd_attr(CD_LIT("disabled"), CD_LIT(""));
    bool_bound(&sel_off[which], sel, CD_LIT("disabled"), busy);
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
  cd_id cta = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("starter-deck-cta"));
  if (cta_is_off()) cd_attr(CD_LIT("disabled"), CD_LIT(""));
  bool_bound(&cta_off, cta, CD_LIT("disabled"), cta_is_off());
  cd_on(cta, CD_EV_CLICK, build_pressed, 0);
  text_bound(&cta_label, busy ? CD_LIT("Building the deck…") : CD_LIT("Make me a starter deck"));
  cd_close();
  note_node = el_id(CD_LIT("p"), CD_LIT("starter-deck-note"));
  cd_text(CD_LIT("To make your own cards, put "));
  el_text(CD_LIT("code"), 0, CD_LIT("GEMINI_API_KEY=…"));
  cd_text(CD_LIT(" in "));
  el_text(CD_LIT("code"), 0, CD_LIT(".env.local"));
  cd_text(CD_LIT(" and restart amgi (get a key at aistudio.google.com/apikey)."));
  cd_close();
  cd_close();
  cd_region_end(&view);
  dirty_patch(); /* the failure, if there is one */
}

ON_RENDER(patch_view) {
  cd_bound_set(&cta_label, busy ? CD_LIT("Building the deck…") : CD_LIT("Make me a starter deck"));
  cd_bound_set_num(&cta_off, cta_is_off());
  cd_bound_set_num(&sel_off[0], busy);
  cd_bound_set_num(&sel_off[1], busy);
  cd_region_hide(&failure);
  if (!error.len || !cd_region_show(&failure, 1)) return;
  cd_at(view.root, note_node);
  el(CD_LIT("p"), CD_LIT("starter-deck-error"));
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
  uint32_t i = input_value(which ? learning_sel : known_sel, code, sizeof code, &n) ? index_of(code, n) : NLANGUAGES;
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
    /* the pair the deck was built from: nothing in Anki records it */
    lang_pair pair;
    uint32_t k = zlen(LANGUAGES[known].code), l = zlen(LANGUAGES[learning].code);
    __builtin_memcpy(pair.known, LANGUAGES[known].code, k + 1);
    __builtin_memcpy(pair.learning, LANGUAGES[learning].code, l + 1);
    deck_langs_save(b.deck_id, &pair);
    open_after_refresh(b.deck_id);
    return;
  }
  busy = 0;
  char m[600];
  text_set(&error, m, answer_message(&a, m, sizeof m));
  dirty_patch();
}
