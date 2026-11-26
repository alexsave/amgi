/* The decks screen (DeckList, DeckItem, CreateDeckModal); FirstRun and StarterDeck in their files. */
#include "app.h"


static cd_region rows = {.up = &page_region};  /* the rows: all the children of .deck-list */
static cd_region modal = {.up = &page_region}; /* CreateDeckModal, between the header and the list */
static cd_region modal_err = {.up = &modal};
static cd_id modal_form, modal_input, modal_buttons;
static text modal_error;
static int shown, setup, creating;

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

void decks_build(void) {
    shown = 1;
    cd_on_free(0, screen_gone, 0);
    el("div", "deck-management");
    /* Setup is the whole screen (FirstRun), not an empty state inside the list: "Decks" and a New
     * Deck button over a machine that cannot make one yet is chrome for a thing that does not exist. */
    setup = decks_setup_wanted();
    if (!setup) {
        el("div", "deck-header");
        el_text("h2", 0, "Decks");
        el("div", "deck-actions");
        cd_id new_button = el_id("button", "action-btn");
        cd_attr("title", "New Deck");
        cd_on(new_button, CD_EV_CLICK, new_deck, 0);
        icon(ICON_PLUS, 0, 0);
        cd_close();
        cd_close();
        cd_close();
        rows.parent = el_id("div", "deck-list");
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
        el("div", "empty-deck-state");
        cd_open("p");
        cd_attr("style", "max-width: 32rem; text-align: center; color: var(--text-secondary);");
        cd_text(present(mode)->title);
        cd_close();
        cd_close();
    } else if (!ndecks) {
        el("div", "empty-deck-state");
        cd_on(el_id("button", "create-first-deck-btn"), CD_EV_CLICK, new_deck, 0);
        icon(ICON_PLUS, 0, "height: 20px; width: 20px;");
        el_text("span", 0, "Create your first deck");
        cd_close();
        cd_close();
    } else {
        for (uint32_t i = 0; i < ndecks; i++) {
            cd_on(el_id("div", "deck-item"), CD_EV_CLICK, open_deck, CTX_OF(i));
            el("div", "deck-info");
            el("h3", 0);
            tmp_text(decks[i].name.p, decks[i].name.len);
            cd_close();
            cd_open("small");
            /* three text nodes, as DeckItem's JSX makes them: the browser shapes text node by text node,
             * and "3 notes" as one run kerns the "3" 1 px from where React draws it */
            cd_text_num(decks[i].count);
            cd_text(" note");
            if (decks[i].count != 1) cd_text("s");
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
    el("div", "error-message");
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
    el("dialog", "modal-overlay");
    cd_name_open(modal.root);
    cd_on(modal.root, CD_EV_CLOSE, modal_closed, 0);
    el("div", "modal-content");
    el("div", "modal-header");
    el_text("h3", 0, "Create New Deck");
    cd_on(el_id("button", "close-btn"), CD_EV_CLICK, modal_dismiss, 0);
    icon_with(ICON_X, 0, 0, "icon");
    cd_close();
    cd_close();
    modal_form = cd_open_id("form");
    cd_attr("autocomplete", "off");
    cd_on(modal_form, CD_EV_SUBMIT, modal_submitted, 0);
    el("div", "form-group");
    cd_open("label");
    cd_attr("for", "deckName");
    cd_text("Deck Name");
    cd_close();
    modal_input = cd_open_id("input");
    cd_attr("id", "deckName");
    cd_attr("type", "text");
    cd_attr("placeholder", "e.g. Korean::Verbs");
    cd_attr("value", "");
    cd_close();
    cd_open("small");
    cd_attr("style", "display: block; margin-top: 0.35rem; opacity: 0.75;");
    cd_text("Use ");
    el_text("code", 0, "::");
    cd_text(" to nest under a parent deck (created automatically if it does not exist yet).");
    cd_close();
    cd_close();
    modal_buttons = el_id("div", "button-row");
    el("button", "primary-btn");
    cd_attr("type", "submit");
    cd_text("Create Deck");
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
    int fits = cd_input_whole(modal_input, name, sizeof name, &len);
    wire_str typed = trim((wire_str){name, fits ? len : 0});
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
