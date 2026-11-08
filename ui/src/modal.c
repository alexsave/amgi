/* A question asked in the page, in place of window.confirm and window.alert (which a page in C has
 * no call for, and which block the whole tab): a <dialog> opened with showModal, so the browser
 * makes the rest of the page inert, keeps the focus inside, closes it on Escape and hands the focus
 * back. Its close event (Escape, Cancel, or the action) is what ends it here. One at a time. */
#include "app.h"

enum { A_CANCEL = 1, A_YES, A_CLOSED };
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

/* then 0: a notice, with OK alone. Otherwise Cancel and yes; then(ctx) runs on yes. */
void confirm_ask(const char *title, const char *body, uint32_t blen, const char *note, const char *yes,
                 void (*then)(void *), void *ctx) {
  forget();
  on_yes = then;
  yes_ctx = ctx;
  answered = 0;
  if (!cd_region_show(&box, 1)) return;
  cd_at(app_content, 0);
  el(CD_LIT("dialog"), CD_LIT("modal-content confirm-dialog"));
  cd_name_open(box.root);
  dialog = box.root;
  cd_listen(dialog, CD_EV_CLOSE);
  cd_tag_set(dialog, TAG(M_MODAL, A_CLOSED, 0));
  el(CD_LIT("div"), CD_LIT("modal-header"));
  el(CD_LIT("h3"), 0);
  tmp_text(title, zlen(title));
  cd_close();
  cd_close();
  if (blen) {
    el(CD_LIT("p"), 0);
    tmp_text(body, blen);
    cd_close();
  }
  if (note) {
    el(CD_LIT("p"), CD_LIT("confirm-note"));
    tmp_text(note, zlen(note));
    cd_close();
  }
  el(CD_LIT("div"), CD_LIT("modal-actions"));
  if (then) {
    el(CD_LIT("button"), CD_LIT("cancel-btn"));
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    listen_click(TAG(M_MODAL, A_CANCEL, 0));
    cd_text(CD_LIT("Cancel"));
    cd_close();
  }
  el(CD_LIT("button"), CD_LIT("submit-btn"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  yes_button = listen_as(CD_EV_CLICK, TAG(M_MODAL, A_YES, 0));
  tmp_text(yes, zlen(yes));
  cd_close();
  cd_close();
  cd_close();
  cd_region_end(&box);
  cd_call(dialog, CD_LIT("showModal"));
  cd_call(yes_button, CD_LIT("focus")); /* the action is the default: Enter takes it */
}

void modal_event(const cd_event_rec *e, uint32_t tag) {
  (void)e;
  switch (TAG_ACTION(tag)) {
  case A_YES:
    answered = 1;
    cd_call(dialog, CD_LIT("close"));
    break;
  case A_CANCEL: cd_call(dialog, CD_LIT("close")); break;
  case A_CLOSED: {
    /* every way out ends here: the action, Cancel, Escape */
    void (*then)(void *) = answered ? on_yes : 0;
    void *ctx = yes_ctx;
    forget();
    if (then) then(ctx);
    break;
  }
  }
}

void confirm_close(void) {
  if (box.shown) cd_call(dialog, CD_LIT("close"));
}
