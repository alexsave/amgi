/* TemplateUpdate: getting a newer card design onto a machine set up months ago. Both halves are
 * checked (GET /install: are the files current, and has the collection caught up), and the notice
 * says which one is behind; it sits first in .app-content, above every screen. */
#include "app.h"

enum { P_CHECKING, P_IDLE, P_OFFERED, P_UPDATING, P_BEHIND, P_FAILED };
enum { T_STATE = 1, T_INSTALL, T_RECHECK };

static uint32_t phase = P_CHECKING;
static int running, dismissed, force;
static text message;
static cd_region view = {0};
static holder h;

/* the modes that mean Anki is open right now: writing under it is writing under a running program */
static int anki_open(void) {
  return mode == WIRE_MODE_BRIDGE || mode == WIRE_MODE_BRIDGE_NO_COLLECTION || mode == WIRE_MODE_LOCKED ||
         mode == WIRE_MODE_BRIDGE_OUTDATED;
}

static void button(cd_str label, cd_event_fn on_click, int aria) {
  cd_id b = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("template-update-dismiss"));
  if (aria) cd_attr(CD_LIT("aria-label"), CD_LIT("Dismiss this notice"));
  cd_on(b, CD_EV_CLICK, on_click, 0);
  cd_text(label);
  cd_close();
}

ON_EVENT(install_now);
ON_EVENT(check_again);
ON_EVENT(dismiss);

static void draw(void) {
  cd_region_hide(&view);
  if (dismissed || phase == P_CHECKING || phase == P_IDLE || !cd_region_show(&view, 1)) return;
  cd_at(app_content, page_root());
  cd_open(CD_LIT("div"));
  cd_class(phase == P_UPDATING ? CD_LIT("template-update is-updating")
           : phase == P_OFFERED ? CD_LIT("template-update is-offered")
           : phase == P_BEHIND  ? CD_LIT("template-update is-behind")
                                : CD_LIT("template-update is-failed"));
  cd_attr(CD_LIT("role"), CD_LIT("status"));
  cd_name_open(view.root);
  if (phase == P_UPDATING) {
    el_text(CD_LIT("span"), 0, CD_LIT("Updating amgi’s files in Anki…"));
  } else if (phase == P_OFFERED) {
    el_text(CD_LIT("span"), 0,
            CD_LIT("amgi has a newer card design, and Anki is open. Installing it rewrites amgi’s add-on while Anki is "
                   "running, so it is waiting for you."));
    button(CD_LIT("Install now"), install_now, 0);
    button(CD_LIT("Dismiss"), dismiss, 1);
  } else if (phase == P_BEHIND) {
    cd_open(CD_LIT("span"));
    cd_text(CD_LIT("amgi has a newer card design. Anki picks it up when it next opens your collection, so "));
    el_text(CD_LIT("strong"), 0, CD_LIT("restart Anki"));
    cd_text(CD_LIT(" to see it."));
    cd_close();
    button(CD_LIT("Check again"), check_again, 0);
    button(CD_LIT("Dismiss"), dismiss, 1);
  } else {
    cd_open(CD_LIT("span"));
    cd_text(CD_LIT("Could not update amgi’s files in Anki: "));
    tmp_text(message.p, message.len);
    cd_close();
    button(CD_LIT("Try again"), check_again, 0);
    button(CD_LIT("Dismiss"), dismiss, 1);
  }
  cd_close();
  cd_region_end(&view);
}

/* The check, from the top: only one at a time (two would copy the same files over each other). */
static void check(int forced) {
  if (running) return;
  running = 1;
  force = forced;
  ask(M_TEMPLATE, T_STATE, "GET", "/install", WIRE_NONE, 0);
}

void template_mode_changed(void) { check(0); }

static void fail(const answer *a) {
  char m[600];
  text_set(&message, m, answer_message(a, m, sizeof m));
  phase = P_FAILED;
  running = 0;
  draw();
}

void template_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (token == T_STATE || token == T_RECHECK) {
    wire_install_state s;
    answer a = take(&h, WK_INSTALL_STATE, status, p, len, &s);
    if (!a.ok) return fail(&a);
    if (!s.installed) {
      phase = P_IDLE;
    } else if (token == T_STATE && s.up_to_date == 0) {
      /* never while Anki is open, unless the person says so */
      if (anki_open() && !force) {
        phase = P_OFFERED;
      } else {
        phase = P_UPDATING;
        draw();
        wire_q_install q = {{settings[S_BASE_DIR].p ? settings[S_BASE_DIR].p : "", settings[S_BASE_DIR].len}};
        ask(M_TEMPLATE, T_INSTALL, "POST", "/install", WK_Q_INSTALL, &q);
        return;
      }
    } else {
      phase = s.collection_checked && s.stale.n ? P_BEHIND : P_IDLE;
    }
    running = 0;
    draw();
  } else if (token == T_INSTALL) {
    wire_installed in;
    answer a = take(&h, WK_INSTALLED, status, p, len, &in);
    if (!a.ok) return fail(&a);
    ask(M_TEMPLATE, T_RECHECK, "GET", "/install", WIRE_NONE, 0);
  }
}

ON_EVENT(install_now) { check(1); }
ON_EVENT(check_again) { check(0); }
ON_EVENT(dismiss) {
  /* for this visit only: a reload brings it back, because what it reports is still true */
  dismissed = 1;
  draw();
}
