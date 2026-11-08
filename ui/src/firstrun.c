/* FirstRun: the whole decks screen on a machine where amgi is not set up yet - find Anki's profile,
 * install the add-ons and the card type, then restart Anki. */
#include "app.h"

enum { T_PROFILES = 1, T_INSTALL };

typedef struct { text name, path; } profile;
static profile *profiles;
static uint32_t nprofiles;
static int scan_loading = 1, base_exists = -1, install_running, install_done, install_failed, needs_restart = 1;
static text base_dir, scan_error, install_message, chosen;
static cd_region view = {0};
static int shown;
static holder h;

static const profile *picked(void) {
  for (uint32_t i = 0; i < nprofiles; i++)
    if (same(profiles[i].path.p, profiles[i].path.len, chosen.p, chosen.len)) return &profiles[i];
  return 0;
}

static void step(cd_str state, const char *mark, const char *s, uint32_t n) {
  cd_open(CD_LIT("li"));
  cd_str cls = state; /* "first-run-step <state>" */
  cd_class(cls);
  el(CD_LIT("span"), CD_LIT("first-run-mark"));
  tmp_text(mark, zlen(mark));
  cd_close();
  el(CD_LIT("span"), CD_LIT("first-run-step-text"));
  tmp_text(s, n);
  cd_close();
  cd_close();
}

static uint32_t cat(char *dst, uint32_t n, const char *s, uint32_t len) {
  __builtin_memcpy(dst + n, s, len);
  return n + len;
}

ON_EVENT(install_pressed);
ON_EVENT(profile_chosen);

static void draw(void) {
  if (!shown) return;
  cd_region_hide(&view);
  if (!cd_region_show(&view, 1)) return;
  const profile *pr = picked();
  int needs_choice = nprofiles > 1 && !pr, no_anki = !scan_loading && base_exists == 0;
  cd_at(view.parent, 0);
  el(CD_LIT("div"), CD_LIT("first-run"));
  el_text(CD_LIT("h2"), CD_LIT("first-run-title"), CD_LIT("Set amgi up in your Anki"));
  el_text(CD_LIT("p"), CD_LIT("first-run-lead"), CD_LIT("One press: the add-ons, and the card type amgi builds decks with."));
  cd_id cta = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("first-run-cta"));
  if (install_running || no_anki) cd_attr(CD_LIT("disabled"), CD_LIT(""));
  cd_on(cta, CD_EV_CLICK, install_pressed, 0);
  cd_text(install_running ? CD_LIT("Installing…") : install_done ? CD_LIT("Install again") : CD_LIT("Install into Anki"));
  cd_close();
  if (base_dir.len) {
    el(CD_LIT("p"), CD_LIT("first-run-path"));
    cd_open(CD_LIT("code"));
    tmp_text(base_dir.p, base_dir.len);
    cd_close();
    if (pr) {
      cd_text(CD_LIT(" · profile “"));
      tmp_text(pr->name.p, pr->name.len);
      cd_text(CD_LIT("”"));
    }
    cd_close();
  }
  if (no_anki)
    el_text(CD_LIT("p"), CD_LIT("first-run-error"),
            CD_LIT("No Anki data folder on this machine. Install Anki from apps.ankiweb.net and open it once, then reload."));
  if (scan_error.len) {
    el(CD_LIT("p"), CD_LIT("first-run-error"));
    tmp_text(scan_error.p, scan_error.len);
    cd_close();
  }
  if (install_failed) {
    el(CD_LIT("p"), CD_LIT("first-run-error"));
    tmp_text(install_message.p, install_message.len);
    cd_close();
  }
  if (needs_choice) {
    el(CD_LIT("div"), CD_LIT("first-run-choices"));
    el_text(CD_LIT("p"), CD_LIT("first-run-step-text"), CD_LIT("More than one Anki profile here. Which one?"));
    for (uint32_t i = 0; i < nprofiles; i++) {
      cd_id choice = el_id(CD_LIT("button"), 0);
      cd_attr(CD_LIT("type"), CD_LIT("button"));
      cd_class(CD_LIT("first-run-choice"));
      cd_on(choice, CD_EV_CLICK, profile_chosen, CTX_OF(i));
      tmp_text(profiles[i].name.p, profiles[i].name.len);
      cd_close();
    }
    cd_close();
  }
  el(CD_LIT("ol"), CD_LIT("first-run-steps"));
  char s[400];
  uint32_t n = 0;
  if (scan_loading) {
    step(CD_LIT("first-run-step now"), "1", "Looking for Anki…", zlen("Looking for Anki…"));
  } else if (pr) {
    n = cat(s, 0, "Found Anki: profile “", zlen("Found Anki: profile “"));
    uint32_t l = pr->name.len < 300 ? pr->name.len : 300;
    n = cat(s, n, pr->name.p, l);
    n = cat(s, n, "”", zlen("”"));
    if (nprofiles == 1) n = cat(s, n, ", picked for you", 16);
    step(CD_LIT("first-run-step done"), "✓", s, n);
  } else {
    step(CD_LIT("first-run-step next"), "1", "Could not find an Anki profile", zlen("Could not find an Anki profile"));
  }
  const char *t2 = install_done ? "Installed the add-ons and the card type"
                   : install_running ? "Installing the add-ons and the card type"
                                     : "Install the add-ons and the card type";
  step(install_done ? CD_LIT("first-run-step done") : install_running ? CD_LIT("first-run-step now") : CD_LIT("first-run-step next"),
       install_done ? "✓" : "2", t2, zlen(t2));
  const char *t3 = install_done && !needs_restart ? "The card type is already in your collection - add cards now"
                                                  : "Restart Anki, and amgi notices by itself";
  step(install_done ? CD_LIT("first-run-step now") : CD_LIT("first-run-step next"), "3", t3, zlen(t3));
  cd_close();
  cd_close();
  cd_region_end(&view);
}

static void choose(uint32_t i) {
  text_set(&settings[S_COLLECTION], profiles[i].path.p, profiles[i].path.len);
  text_set(&settings[S_PROFILE], profiles[i].name.p, profiles[i].name.len);
  text_set(&chosen, profiles[i].path.p, profiles[i].path.len);
  settings_save();
  poll_status();
  refresh_decks();
}

/* Shown as all of parent's children (the decks screen's root); the scan starts at once. */
void firstrun_show(cd_id parent) {
  shown = 1;
  view.parent = parent;
  text_set(&chosen, settings[S_COLLECTION].p ? settings[S_COLLECTION].p : "", settings[S_COLLECTION].len);
  scan_loading = 1;
  text_free(&scan_error);
  draw();
  ask(M_FIRSTRUN, T_PROFILES, "GET", "/profiles", WIRE_NONE, 0);
}
void firstrun_forget(void) {
  if (!shown) return;
  shown = 0;
  cd_region_hide(&view);
  view.parent = 0;
}

ON_EVENT(profile_chosen) {
  if (CTX_INDEX(ctx) < nprofiles) choose(CTX_INDEX(ctx));
  draw();
}
ON_EVENT(install_pressed) {
  if (install_running) return;
  install_running = 1;
  install_failed = 0;
  draw();
  wire_q_install q = {{settings[S_BASE_DIR].p ? settings[S_BASE_DIR].p : "", settings[S_BASE_DIR].len}};
  ask(M_FIRSTRUN, T_INSTALL, "POST", "/install", WK_Q_INSTALL, &q);
}

void firstrun_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  char m[600];
  if (token == T_PROFILES) {
    wire_profiles pr;
    answer a = take(&h, WK_PROFILES, status, p, len, &pr);
    scan_loading = 0;
    if (a.ok) {
      for (uint32_t i = 0; i < nprofiles; i++) {
        text_free(&profiles[i].name);
        text_free(&profiles[i].path);
      }
      profiles = cd_realloc(profiles, (pr.nprofiles ? pr.nprofiles : 1) * sizeof *profiles);
      for (uint32_t i = 0; i < pr.nprofiles; i++) {
        profiles[i] = (profile){{0, 0}, {0, 0}};
        text_set(&profiles[i].name, pr.profiles[i].name.p, pr.profiles[i].name.len);
        text_set(&profiles[i].path, pr.profiles[i].collection_path.p, pr.profiles[i].collection_path.len);
      }
      nprofiles = pr.nprofiles;
      text_set(&base_dir, pr.base_dir.p, pr.base_dir.len);
      base_exists = pr.base_dir_exists;
      /* one profile and none picked yet: picked for you */
      if (nprofiles == 1 && !settings[S_COLLECTION].len) choose(0);
    } else {
      text_set(&scan_error, m, answer_message(&a, m, sizeof m));
    }
  } else if (token == T_INSTALL) {
    wire_installed in;
    answer a = take(&h, WK_INSTALLED, status, p, len, &in);
    install_running = 0;
    if (a.ok) {
      install_done = 1;
      needs_restart = in.needs_restart;
      text_set(&install_message, in.message.p, in.message.len);
      refresh_decks();
    } else {
      install_failed = 1;
      text_set(&install_message, m, answer_message(&a, m, sizeof m));
    }
  }
  draw();
}
