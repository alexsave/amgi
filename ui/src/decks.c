/* The decks screen (DeckList, DeckItem, CreateDeckModal); FirstRun and StarterDeck in their files. */
#include "app.h"

enum { A_NEW_DECK = 1, A_DECK, A_MODAL_CLOSE, A_MODAL_SUBMIT };
enum { T_CREATE = 1 };

static cd_region rows = {0};  /* the rows: all the children of .deck-list */
static cd_region modal = {0}; /* CreateDeckModal, between the header and the list */
static cd_region modal_err = {0};
static cd_id modal_form, modal_input, modal_buttons;
static text modal_error;
static int shown, setup, creating;

void decks_build(void) {
  shown = 1;
  el(CD_LIT("div"), CD_LIT("deck-management"));
  /* Setup is the whole screen (FirstRun), not an empty state inside the list: "Decks" and a New
   * Deck button over a machine that cannot make one yet is chrome for a thing that does not exist. */
  setup = decks_setup_wanted();
  rows.parent = 0;
  if (setup) return;
  el(CD_LIT("div"), CD_LIT("deck-header"));
  el_text(CD_LIT("h2"), 0, CD_LIT("Decks"));
  el(CD_LIT("div"), CD_LIT("deck-actions"));
  el(CD_LIT("button"), CD_LIT("action-btn"));
  cd_attr(CD_LIT("title"), CD_LIT("New Deck"));
  listen_click(TAG(M_DECKS, A_NEW_DECK, 0));
  icon(ICON_PLUS, 0, 0);
  cd_close();
  cd_close();
  cd_close();
  rows.parent = el_id(CD_LIT("div"), CD_LIT("deck-list"));
  cd_close();
}

static void modal_close(void) {
  cd_region_hide(&modal_err);
  cd_region_hide(&modal);
  text_free(&modal_error);
  creating = 0;
}

/* Setup is the screen while amgi is not installed or no profile is picked; once both hold, the
 * list. Asked whenever the mode or the install state changes (state.c): a first run that picked a
 * profile, or finished its install, gives way to the decks as DeckList's render did. */
int decks_setup_wanted(void) { return installed == 0 || mode == WIRE_MODE_UNCONFIGURED; }
int decks_setup_shown(void) { return shown && setup; }

void decks_forget(void) {
  if (!shown) return;
  shown = 0;
  modal_close();
  firstrun_forget();
  starter_forget();
  if (rows.parent) cd_region_hide(&rows);
  rows.parent = 0;
}

void decks_rows(void) {
  if (!shown) return;
  if (setup) {
    firstrun_show(page_root());
    return;
  }
  cd_region_hide(&rows);
  if (!rows.parent || !cd_region_show(&rows, 1)) return;
  cd_at(rows.parent, 0);
  if (!ready()) {
    /* Not ready wins over whatever decks are still in hand: a list you cannot act on, under a
     * badge saying so, read as data loss. Say what the mode means instead. */
    el(CD_LIT("div"), CD_LIT("empty-deck-state"));
    cd_open(CD_LIT("p"));
    cd_attr(CD_LIT("style"), CD_LIT("max-width: 32rem; text-align: center; color: var(--text-secondary);"));
    cd_text(cd_internz(present(mode)->title));
    cd_close();
    cd_close();
  } else if (!ndecks) {
    el(CD_LIT("div"), CD_LIT("empty-deck-state"));
    el(CD_LIT("button"), CD_LIT("create-first-deck-btn"));
    listen_click(TAG(M_DECKS, A_NEW_DECK, 0));
    icon(ICON_PLUS, 0, CD_LIT("height: 20px; width: 20px;"));
    el_text(CD_LIT("span"), 0, CD_LIT("Create your first deck"));
    cd_close();
    cd_close();
  } else {
    for (uint32_t i = 0; i < ndecks; i++) {
      el(CD_LIT("div"), CD_LIT("deck-item"));
      listen_click(TAG(M_DECKS, A_DECK, i));
      el(CD_LIT("div"), CD_LIT("deck-info"));
      el_text(CD_LIT("h3"), 0, decks[i].name);
      cd_open(CD_LIT("small"));
      /* three text nodes, as DeckItem's JSX makes them: the browser shapes text node by text node,
       * and "3 notes" as one run kerns the "3" 1 px from where React draws it */
      cd_text_num(decks[i].count);
      cd_text(CD_LIT(" note"));
      if (decks[i].count != 1) cd_text(CD_LIT("s"));
      cd_close();
      cd_close();
      cd_close();
    }
  }
  cd_region_end(&rows);
  /* Below the list, and only when ready: the free sample deck, for a machine with no key. */
  if (ready()) starter_show(page_root());
}

static void modal_error_view(void) {
  cd_region_hide(&modal_err);
  if (!modal_error.len || !cd_region_show(&modal_err, 1)) return;
  cd_at(modal_form, modal_buttons);
  el(CD_LIT("div"), CD_LIT("error-message"));
  cd_name_open(modal_err.root);
  tmp_text(modal_error.p, modal_error.len);
  cd_close();
  cd_region_end(&modal_err);
}

static void modal_open(void) {
  modal_close();
  if (!rows.parent || !cd_region_show(&modal, 1)) return;
  cd_at(page_root(), rows.parent);
  el(CD_LIT("div"), CD_LIT("modal-overlay"));
  cd_name_open(modal.root);
  el(CD_LIT("div"), CD_LIT("modal-content"));
  el(CD_LIT("div"), CD_LIT("modal-header"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Create New Deck"));
  el(CD_LIT("button"), CD_LIT("close-btn"));
  listen_click(TAG(M_DECKS, A_MODAL_CLOSE, 0));
  icon_with(ICON_X, 0, 0, CD_LIT("icon"));
  cd_close();
  cd_close();
  cd_open(CD_LIT("form"));
  cd_attr(CD_LIT("autocomplete"), CD_LIT("off"));
  modal_form = listen_as(CD_EV_SUBMIT, TAG(M_DECKS, A_MODAL_SUBMIT, 0));
  el(CD_LIT("div"), CD_LIT("form-group"));
  cd_open(CD_LIT("label"));
  cd_attr(CD_LIT("for"), CD_LIT("deckName"));
  cd_text(CD_LIT("Deck Name"));
  cd_close();
  modal_input = cd_open_id(CD_LIT("input"));
  cd_attr(CD_LIT("id"), CD_LIT("deckName"));
  cd_attr(CD_LIT("type"), CD_LIT("text"));
  cd_attr(CD_LIT("placeholder"), CD_LIT("e.g. Korean::Verbs"));
  cd_attr(CD_LIT("value"), CD_LIT(""));
  cd_close();
  cd_open(CD_LIT("small"));
  cd_attr(CD_LIT("style"), CD_LIT("display: block; margin-top: 0.35rem; opacity: 0.75;"));
  cd_text(CD_LIT("Use "));
  el_text(CD_LIT("code"), 0, CD_LIT("::"));
  cd_text(CD_LIT(" to nest under a parent deck (created automatically if it does not exist yet)."));
  cd_close();
  cd_close();
  modal_buttons = el_id(CD_LIT("div"), CD_LIT("button-row"));
  el(CD_LIT("button"), CD_LIT("primary-btn"));
  cd_attr(CD_LIT("type"), CD_LIT("submit"));
  cd_text(CD_LIT("Create Deck"));
  cd_close();
  cd_close();
  cd_close(); /* form */
  cd_close();
  cd_close();
  cd_region_end(&modal);
  cd_call(modal_input, CD_LIT("focus")); /* autoFocus */
}

static void modal_submit(void) {
  char name[512];
  wire_str typed = trim((wire_str){name, cd_input_value(modal_input, name, sizeof name)});
  if (!typed.len) {
    text_setz(&modal_error, "Enter a deck name");
    modal_error_view();
    return;
  }
  if (creating) return;
  creating = 1;
  text_free(&modal_error);
  modal_error_view();
  wire_q_deck_name q = {typed};
  ask(M_DECKS, T_CREATE, "POST", "/decks", WK_Q_DECK_NAME, &q);
}

static holder h;
void decks_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (token != T_CREATE) return;
  wire_deck_created d;
  answer a = take(&h, WK_DECK_CREATED, status, p, len, &d);
  creating = 0;
  if (a.ok) {
    modal_close();
    open_after_refresh(d.id);
    return;
  }
  char m[600] = "Failed to create deck: ";
  uint32_t n = 23 + answer_message(&a, m + 23, sizeof m - 23);
  text_set(&modal_error, m, n);
  modal_error_view();
}

void decks_event(const cd_event_rec *e, uint32_t tag) {
  switch (TAG_ACTION(tag)) {
  case A_DECK: {
    uint32_t i = TAG_INDEX(tag);
    if (i < ndecks) go_deck(decks[i].id);
    break;
  }
  case A_NEW_DECK: modal_open(); break;
  case A_MODAL_CLOSE: modal_close(); break;
  case A_MODAL_SUBMIT:
    cd_prevent_default();
    (void)e;
    modal_submit();
    break;
  }
}
