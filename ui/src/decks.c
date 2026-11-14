/* The decks screen (DeckList, DeckItem, CreateDeckModal); FirstRun and StarterDeck in their files. */
#include "app.h"


static cd_region rows = {.up = &page_region};  /* the rows: all the children of .deck-list */
static cd_region modal = {.up = &page_region}; /* CreateDeckModal, between the header and the list */
static cd_region modal_err = {.up = &modal};
static cd_id modal_form, modal_input, modal_buttons;
static text modal_error;
static int shown, setup, creating;

/* The views are renders (cd_dirty), drawn from state in the flush that ends the entry. Two guards, for two vectors:
 * dirty() asks only while its owner is up (alive: the screen, or the dialog), which covers an ask made after it went
 * (a late answer); the cd_undirty in the owner's cleanup covers an ask made earlier in the same entry. */
static void dirty(cd_render_fn view, const int *alive) {
  if (*alive) cd_dirty(view, 0);
}
ON_RENDER(rows_view);
ON_RENDER(modal_error_view);

ON_EVENT(new_deck);
ON_EVENT(open_deck) {
  uint32_t i = CTX_INDEX(ctx);
  if (i < ndecks) go_deck(decks[i].id);
}

static void screen_gone(void *ctx) {
  (void)ctx;
  shown = 0;
  cd_undirty(rows_view, 0);
}

/* The screen, then its rows (or the setup screen) as regions of the page. */
void decks_build(void) {
  shown = 1;
  cd_on_free(0, screen_gone, 0);
  el(CD_LIT("div"), CD_LIT("deck-management"));
  /* Setup is the whole screen (FirstRun), not an empty state inside the list: "Decks" and a New
   * Deck button over a machine that cannot make one yet is chrome for a thing that does not exist. */
  setup = decks_setup_wanted();
  if (!setup) {
    el(CD_LIT("div"), CD_LIT("deck-header"));
    el_text(CD_LIT("h2"), 0, CD_LIT("Decks"));
    el(CD_LIT("div"), CD_LIT("deck-actions"));
    cd_id new_button = el_id(CD_LIT("button"), CD_LIT("action-btn"));
    cd_attr(CD_LIT("title"), CD_LIT("New Deck"));
    cd_on(new_button, CD_EV_CLICK, new_deck, 0);
    icon(ICON_PLUS, 0, 0);
    cd_close();
    cd_close();
    cd_close();
    rows.parent = el_id(CD_LIT("div"), CD_LIT("deck-list"));
    cd_close();
  }
  decks_rows();
}

/* Setup is the screen while amgi is not installed or no profile is picked; once both hold, the
 * list. Asked whenever the mode or the install state changes (state.c): a first run that picked a
 * profile, or finished its install, gives way to the decks as DeckList's render did. */
int decks_setup_wanted(void) { return installed == 0 || mode == WIRE_MODE_UNCONFIGURED; }
int decks_setup_shown(void) { return shown && setup; }

void decks_rows(void) { dirty(rows_view, &shown); }

/* The list, or what stands in for it; the setup screen and the starter offer come with it. */
ON_RENDER(rows_view) {
  if (setup) {
    firstrun_show(page_root());
    return;
  }
  cd_region_hide(&rows);
  if (!cd_region_show(&rows, 1)) return;
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
    cd_on(el_id(CD_LIT("button"), CD_LIT("create-first-deck-btn")), CD_EV_CLICK, new_deck, 0);
    icon(ICON_PLUS, 0, CD_LIT("height: 20px; width: 20px;"));
    el_text(CD_LIT("span"), 0, CD_LIT("Create your first deck"));
    cd_close();
    cd_close();
  } else {
    for (uint32_t i = 0; i < ndecks; i++) {
      cd_on(el_id(CD_LIT("div"), CD_LIT("deck-item")), CD_EV_CLICK, open_deck, CTX_OF(i));
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

ON_RENDER(modal_error_view) {
  cd_region_hide(&modal_err);
  if (!modal_error.len || !cd_region_show(&modal_err, 1)) return;
  cd_at(modal_form, modal_buttons);
  el(CD_LIT("div"), CD_LIT("error-message"));
  cd_name_open(modal_err.root);
  tmp_text(modal_error.p, modal_error.len);
  cd_close();
  cd_region_end(&modal_err);
}

/* Every way out of the modal ends in its dialog's close event: Escape, the X and a made deck all
 * ask the dialog to close, and this is the one place that takes it away. */
ON_EVENT(modal_closed) { cd_region_hide(&modal); }
ON_EVENT(modal_dismiss) {
  if (modal.shown) dialog_close(modal.root);
}
ON_EVENT(modal_submitted);

/* The dialog's own state goes with it, whichever way it goes: closed, or the page left. */
static void modal_gone(void *ctx) {
  (void)ctx;
  text_free(&modal_error);
  creating = 0;
  cd_undirty(modal_error_view, 0);
}

static void modal_open(void) {
  cd_region_hide(&modal);
  if (!shown || setup || !cd_region_show(&modal, 1)) return;
  cd_on_free(0, modal_gone, 0);
  cd_at(page_root(), rows.parent);
  el(CD_LIT("dialog"), CD_LIT("modal-overlay"));
  cd_name_open(modal.root);
  cd_on(modal.root, CD_EV_CLOSE, modal_closed, 0);
  el(CD_LIT("div"), CD_LIT("modal-content"));
  el(CD_LIT("div"), CD_LIT("modal-header"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Create New Deck"));
  cd_on(el_id(CD_LIT("button"), CD_LIT("close-btn")), CD_EV_CLICK, modal_dismiss, 0);
  icon_with(ICON_X, 0, 0, CD_LIT("icon"));
  cd_close();
  cd_close();
  modal_form = cd_open_id(CD_LIT("form"));
  cd_attr(CD_LIT("autocomplete"), CD_LIT("off"));
  cd_on(modal_form, CD_EV_SUBMIT, modal_submitted, 0);
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
  dialog_show(modal.root, modal_input); /* autoFocus */
}

ON_ANSWER(created);

static void modal_submit(void) {
  char name[512];
  uint32_t len;
  int fits = input_value(modal_input, name, sizeof name, &len);
  wire_str typed = trim((wire_str){name, len});
  if (!fits || !typed.len) {
    text_setz(&modal_error, fits ? "Enter a deck name" : "That name is too long");
    dirty(modal_error_view, &modal.shown);
    return;
  }
  if (creating) return;
  creating = 1;
  text_free(&modal_error);
  dirty(modal_error_view, &modal.shown);
  wire_q_deck_name q = {typed};
  ask(created, 0, "POST", "/decks", WK_Q_DECK_NAME, &q);
}

ON_EVENT(new_deck) { modal_open(); }
ON_EVENT(modal_submitted) {
  cd_prevent_default();
  modal_submit();
}

static holder h;
ON_ANSWER(created) {
  wire_deck_created d;
  answer a = take(&h, WK_DECK_CREATED, status, p, len, &d);
  creating = 0;
  /* The answer can come after the person left the decks page: the modal and its ids went with the
   * page. Draw nothing and close nothing then, and do not navigate: a made deck only joins the list. */
  if (!modal.shown) {
    if (a.ok) refresh_decks();
    return;
  }
  if (a.ok) {
    dialog_close(modal.root);
    open_after_refresh(d.id);
    return;
  }
  char m[600] = "Failed to create deck: ";
  uint32_t n = 23 + answer_message(&a, m + 23, sizeof m - 23);
  text_set(&modal_error, m, n);
  dirty(modal_error_view, &modal.shown);
}
