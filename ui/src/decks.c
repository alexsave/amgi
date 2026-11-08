/* The decks screen (DeckList, DeckItem). */
#include "app.h"

enum { A_NEW_DECK = 1, A_DECK };

static cd_region rows = {0}; /* the rows: all the children of .deck-list */
static int shown;

void decks_build(void) {
  shown = 1;
  el(CD_LIT("div"), CD_LIT("deck-management"));
  /* Setup is the whole screen (FirstRun), not an empty state inside the list. */
  if (installed == 0 || mode == WIRE_MODE_UNCONFIGURED) {
    rows.parent = 0;
    el_text(CD_LIT("div"), CD_LIT("first-run"), CD_LIT("FirstRun is ported in phase 2."));
    return;
  }
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
  el(CD_LIT("div"), CD_LIT("deck-list"));
  rows.parent = cd_id_new();
  cd_name_open(rows.parent);
  cd_close();
}

void decks_forget(void) {
  if (!shown) return;
  shown = 0;
  if (rows.parent) cd_region_hide(&rows);
  rows.parent = 0;
}

void decks_rows(void) {
  if (!shown || !rows.parent) return;
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
}

void decks_event(const cd_event_rec *e, uint32_t tag) {
  (void)e;
  switch (TAG_ACTION(tag)) {
  case A_DECK: {
    uint32_t i = TAG_INDEX(tag);
    if (i < ndecks) go_deck(decks[i].id);
    break;
  }
  case A_NEW_DECK: break; /* CreateDeckModal: phase 2 */
  }
}
