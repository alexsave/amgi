/* A question asked in the page, in place of window.confirm and window.alert (which a page in C has
 * no call for, and which block the whole tab): a <dialog> opened with showModal, so the browser
 * makes the rest of the page inert, keeps the focus inside, closes it on Escape and hands the focus
 * back. Its close event (Escape, Cancel, or the action) is what ends it here. One at a time. */
#include "app.h"

/* The two modal dialogs' shared half: open one the browser makes modal, with the focus where its
 * first keystroke belongs, and close it. What follows a close is the dialog's own CD_EV_CLOSE handler. */
void dialog_show(cd_id dialog, cd_id focus) {
    cd_call(dialog, "showModal");
    cd_call(focus, "focus");
}
void dialog_close(cd_id dialog) { cd_call(dialog, "close"); }

static cd_region box = {0};
static void (*on_yes)(void *);
static void *yes_ctx;
static cd_id dialog, yes_button;
static int answered;

static void forget(void) {
    cd_region_hide(&box);
    on_yes = 0;
    yes_ctx = 0;
}

ON_EVENT(yes_pressed) {
    answered = 1;
    dialog_close(dialog);
}
ON_EVENT(cancel_pressed) { dialog_close(dialog); }
/* every way out ends here: the action, Cancel, Escape */
ON_EVENT(closed) {
    void (*then)(void *) = answered ? on_yes : 0;
    void *then_ctx = yes_ctx;
    forget();
    if (then) then(then_ctx);
}

/* then 0: a notice, with OK alone. Otherwise Cancel and yes; then(ctx) runs on yes. */
void confirm_ask(const char *title, const char *body, uint32_t blen, const char *note, const char *yes,
                 void (*then)(void *), void *ctx) {
    forget();
    on_yes = then;
    yes_ctx = ctx;
    answered = 0;
    if (!cd_region_show(&box, 1)) return;
    cd_at(app_content, 0);
    el("dialog", "modal-content confirm-dialog");
    cd_name_open(box.root);
    dialog = box.root;
    cd_on(dialog, CD_EV_CLOSE, closed, 0);
    el("div", "modal-header");
    el("h3", 0);
    tmp_text(title, zlen(title));
    cd_close();
    cd_close();
    if (blen) {
        el("p", 0);
        tmp_text(body, blen);
        cd_close();
    }
    if (note) {
        el("p", "confirm-note");
        tmp_text(note, zlen(note));
        cd_close();
    }
    el("div", "modal-actions");
    if (then) {
        cd_id cancel = el_id("button", "cancel-btn");
        cd_attr("type", "button");
        cd_on(cancel, CD_EV_CLICK, cancel_pressed, 0);
        cd_text("Cancel");
        cd_close();
    }
    yes_button = el_id("button", "submit-btn");
    cd_attr("type", "button");
    cd_on(yes_button, CD_EV_CLICK, yes_pressed, 0);
    tmp_text(yes, zlen(yes));
    cd_close();
    cd_close();
    cd_close();
    cd_region_end(&box);
    dialog_show(dialog, yes_button); /* the action is the default: Enter takes it */
}

void confirm_close(void) {
    if (box.shown) dialog_close(dialog);
}
