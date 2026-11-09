/* The settings (which Anki folder, profile and bridge), kept in the store as the five header lines
 * the server reads, and the Settings screen (Settings, AnkiSetupPanel). */
#include "app.h"

static const char *const HEADERS[S_FIELDS] = {
  "X-Amgi-Base-Dir", "X-Amgi-Collection", "X-Amgi-Profile", "X-Amgi-Bridge-Url", "X-Amgi-Bridge-Token",
};
#define STORE_KEY "amgi:anki-settings:1"
#define DEFAULT_BRIDGE_URL "http://127.0.0.1:8798"
text settings[S_FIELDS];
int settings_stored, settings_loaded;

uint32_t settings_block(char *dst, const text *s) {
  uint32_t n = 0;
  for (int f = 0; f < S_FIELDS; f++) {
    uint32_t k = zlen(HEADERS[f]);
    __builtin_memcpy(dst + n, HEADERS[f], k);
    n += k;
    dst[n++] = ':';
    dst[n++] = ' ';
    n += cd_url_encode(dst + n, s[f].p ? s[f].p : "", s[f].len);
    dst[n++] = '\n';
  }
  return n;
}
uint32_t settings_room(const text *s) {
  uint32_t n = 0;
  for (int f = 0; f < S_FIELDS; f++) n += zlen(HEADERS[f]) + 3 + 3 * s[f].len;
  return n;
}

/* A stored block back into the five fields. */
static void settings_read(const uint8_t *p, uint32_t len) {
  const char *s = (const char *)p, *end = s + len;
  while (s < end) {
    const char *eol = s;
    while (eol < end && *eol != '\n') eol++;
    for (int f = 0; f < S_FIELDS; f++) {
      uint32_t k = zlen(HEADERS[f]);
      if ((uint32_t)(eol - s) >= k + 2 && same(s, k, HEADERS[f], k) && s[k] == ':' && s[k + 1] == ' ') {
        uint32_t vlen = (uint32_t)(eol - s) - k - 2;
        char *buf = cd_alloc(vlen + 1);
        text_set(&settings[f], buf, cd_url_decode(buf, s + k + 2, vlen));
        cd_free(buf);
      }
    }
    s = eol + 1;
  }
}

void settings_load(void) {
  cd_store_get(STORE_TOKEN(STORE_SETTINGS, 1), STORE_KEY, sizeof STORE_KEY - 1, CD_STORE_DEADLINE_MS);
}
void settings_got(const uint8_t *p, int32_t len) {
  if (settings_loaded) return;
  if (len >= 0) {
    settings_stored = 1;
    settings_read(p, (uint32_t)len);
  }
  settings_loaded = 1;
  page_show();
  state_start();
}
void settings_save(void) {
  settings_stored = 1;
  char *block = cd_alloc(settings_room(settings));
  uint32_t n = settings_block(block, settings);
  cd_store_put(STORE_TOKEN(STORE_SETTINGS, 2), STORE_KEY, sizeof STORE_KEY - 1, block, n);
  cd_free(block);
}

/* ---- the screen ---- */

static text draft[S_FIELDS];      /* what the screen shows: the saved settings, then the picks */
typedef struct { text name, path; } profile;
static profile *profiles;
static uint32_t nprofiles;
static int scan_loading, scan_exists = -1, saved_shown, install_running, install_ok = -1;
static text scan_base, scan_error, install_message, save_error;
static cd_id section, scan_button, scan_text, install_button, install_text, base_input, url_input, token_input, saved_slot,
  install_block;
/* the scan's messages or the profile list, after "Bridge token" and before Save: the scan answers
 * after the screen is drawn, and nothing a person may be aiming at sits below it but Save */
static cd_region scan_out = {0};
static cd_region saved_msg = {0};  /* "Anki settings saved.", or why they were not */
static cd_region install_msg = {0};
static int shown;

static void row_open(void) { el(CD_LIT("div"), CD_LIT("preference-item")); }
static void label(const char *for_id, cd_str s) {
  cd_open(CD_LIT("label"));
  if (for_id) cd_attr(CD_LIT("for"), cd_internz(for_id));
  cd_text(s);
  cd_close();
}
static cd_id text_input(const char *id, const text *value, cd_str placeholder) {
  cd_id node = cd_open_id(CD_LIT("input"));
  cd_attr(CD_LIT("id"), cd_internz(id));
  cd_attr(CD_LIT("type"), CD_LIT("text"));
  cd_str v = CD_LIT("value");
  attr_tmp(v, value->p ? value->p : "", value->len);
  cd_attr(CD_LIT("placeholder"), placeholder);
  cd_close();
  return node;
}
static cd_id save_button(cd_event_fn on_click, cd_str s, cd_id *txt) {
  cd_id b = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("save-button"));
  cd_on(b, CD_EV_CLICK, on_click, 0);
  cd_text(s);
  if (txt) cd_name_text(*txt = cd_id_new());
  cd_close();
  return b;
}

ON_EVENT(back) { cd_url_step(-1); }
ON_EVENT(install_pressed);
ON_EVENT(scan_pressed);
ON_EVENT(save_pressed);

void settings_build(void) {
  for (int f = 0; f < S_FIELDS; f++) text_set(&draft[f], settings[f].p ? settings[f].p : "", settings[f].len);
  if (!settings_stored || !draft[S_BRIDGE_URL].len) text_setz(&draft[S_BRIDGE_URL], DEFAULT_BRIDGE_URL);
  shown = 1;
  el(CD_LIT("div"), CD_LIT("settings-page"));
  el(CD_LIT("div"), CD_LIT("settings-header"));
  cd_on(el_id(CD_LIT("button"), CD_LIT("back-button")), CD_EV_CLICK, back, 0);
  cd_text(CD_LIT("← Back"));
  cd_close();
  el_text(CD_LIT("h2"), 0, CD_LIT("Settings"));
  cd_close();

  el(CD_LIT("div"), CD_LIT("settings-content"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Anki (local)"));
  section = el_id(CD_LIT("div"), CD_LIT("preferences-section"));

  row_open();
  cd_attr(CD_LIT("style"), CD_LIT("align-items: center;"));
  label(0, CD_LIT("Current mode"));
  badge_build(&badges[1]);
  cd_close();

  install_block = el_id(CD_LIT("div"), CD_LIT("preference-item install-block"));
  label(0, CD_LIT("Install amgi into Anki"));
  el_text(CD_LIT("p"), CD_LIT("preference-help"),
          CD_LIT("Adds amgi’s microphone and bridge add-ons, and the “amgi Listening” note type, to the Anki on this "
                 "machine. Safe to run again to update them."));
  el(CD_LIT("p"), CD_LIT("preference-help"));
  cd_text(CD_LIT("Installs into "));
  cd_open(CD_LIT("code"));
  if (draft[S_BASE_DIR].len) tmp_text(draft[S_BASE_DIR].p, draft[S_BASE_DIR].len);
  else cd_text(CD_LIT("your default Anki data folder"));
  cd_close();
  if (!draft[S_BASE_DIR].len) cd_text(CD_LIT(" - set the override below to install somewhere else."));
  cd_close();
  install_button = save_button(install_pressed, CD_LIT("Install into Anki"), &install_text);
  cd_close();

  row_open();
  label("ankiBaseDir", CD_LIT("Anki data folder (optional override)"));
  base_input = text_input("ankiBaseDir", &draft[S_BASE_DIR], CD_LIT("Leave blank to use the default Anki2 folder for this OS"));
  cd_close();

  row_open();
  scan_button = save_button(scan_pressed, CD_LIT("Scan for profiles"), &scan_text);
  cd_close();

  row_open();
  label("bridgeUrl", CD_LIT("Bridge address"));
  url_input = text_input("bridgeUrl", &draft[S_BRIDGE_URL], CD_LIT("http://127.0.0.1:8798"));
  cd_close();
  row_open();
  label("bridgeToken", CD_LIT("Bridge token"));
  token_input = text_input("bridgeToken", &draft[S_BRIDGE_TOKEN], CD_LIT("From Anki's Tools > amgi: Bridge status…"));
  cd_close();

  saved_slot = el_id(CD_LIT("div"), CD_LIT("preference-item"));
  save_button(save_pressed, CD_LIT("Save Anki settings"), 0);
  cd_close();

  cd_close(); /* .preferences-section */
  cd_close(); /* .settings-content: .settings-page stays open for the shell to close */
}

void settings_forget(void) {
  if (!shown) return;
  shown = 0;
  text_free(&save_error);
  cd_region_hide(&scan_out);
  cd_region_hide(&saved_msg);
  cd_region_hide(&install_msg);
}

ON_EVENT(profile_picked) {
  uint32_t i = CTX_INDEX(ctx);
  if (i < nprofiles) {
    text_set(&draft[S_COLLECTION], profiles[i].path.p, profiles[i].path.len);
    text_set(&draft[S_PROFILE], profiles[i].name.p, profiles[i].name.len);
  }
}

/* The scan's part of the screen, built again whenever the scan changes: the button's label, then
 * (once done) the error, the missing-folder or no-profile message, or the profile radios. */
static void scan_view(void) {
  if (!shown) return;
  cd_set_text(scan_text, scan_loading ? CD_LIT("Scanning…") : CD_LIT("Scan for profiles"));
  cd_set_bool(scan_button, CD_LIT("disabled"), scan_loading);
  cd_region_hide(&scan_out);
  int none = !scan_loading && scan_exists == 1 && !nprofiles, missing = !scan_loading && scan_exists == 0;
  if (!scan_error.len && !none && !missing && !nprofiles) return;
  if (!cd_region_show(&scan_out, 1)) return;
  cd_at(section, saved_msg.shown ? saved_msg.root : saved_slot); /* above Save's own message */
  cd_open(CD_LIT("div"));
  cd_name_open(scan_out.root);
  if (scan_error.len) {
    cd_class(CD_LIT("message error"));
    tmp_text(scan_error.p, scan_error.len);
  } else if (missing) {
    cd_class(CD_LIT("message error"));
    cd_text(CD_LIT("No Anki data folder was found at "));
    cd_open(CD_LIT("code"));
    tmp_text(scan_base.p ? scan_base.p : "", scan_base.len);
    cd_close();
    cd_text(CD_LIT(". If Anki is not installed yet, install it and open it once to create a profile, then scan again."));
  } else if (none) {
    cd_class(CD_LIT("message error"));
    cd_text(CD_LIT("Found the Anki data folder but no profile with a collection in it yet - open Anki once to create one."));
  } else {
    cd_class(CD_LIT("preference-item"));
    cd_attr(CD_LIT("style"), CD_LIT("flex-direction: column; align-items: stretch; gap: 0.4rem;"));
    label(0, CD_LIT("Profile"));
    for (uint32_t i = 0; i < nprofiles; i++) {
      cd_open(CD_LIT("label"));
      cd_attr(CD_LIT("style"), CD_LIT("display: flex; gap: 0.5rem; align-items: center; font-weight: 400;"));
      cd_id radio = cd_open_id(CD_LIT("input"));
      cd_attr(CD_LIT("type"), CD_LIT("radio"));
      cd_attr(CD_LIT("name"), CD_LIT("ankiProfile"));
      if (same(profiles[i].path.p, profiles[i].path.len, draft[S_COLLECTION].p, draft[S_COLLECTION].len))
        cd_attr(CD_LIT("checked"), CD_LIT(""));
      cd_on(radio, CD_EV_CHANGE, profile_picked, CTX_OF(i));
      cd_close();
      tmp_text(profiles[i].name.p, profiles[i].name.len);
      cd_close();
    }
  }
  cd_close();
  cd_region_end(&scan_out);
}

ON_ANSWER(profiles_answered);
ON_ANSWER(installed_answered);

/* The Anki data folder, as scan, install and save all read it (base_dir_value): shorter than
 * MAX_BASE_DIR bytes, so a path that saves also scans and installs. The server hands the path to the
 * file system as it is (opendir, then the profile and add-on paths under it), and on macOS no path
 * of PATH_MAX (1024) bytes or more opens (ENAMETOOLONG). */
#define MAX_BASE_DIR 1024
#define TOO_LONG_BASE "The Anki data folder path is too long"

/* The typed folder into buf (MAX_BASE_DIR bytes): 1 with *n its length when it is shorter than
 * MAX_BASE_DIR, else 0. */
static int base_dir_value(char *buf, uint32_t *n) { return input_value(base_input, buf, MAX_BASE_DIR - 1, n); }

static void scan(void) {
  scan_loading = 1;
  text_free(&scan_error);
  scan_view();
  /* The typed override, without saving it: a scan is a preview, not a commitment. */
  text probe[S_FIELDS];
  for (int f = 0; f < S_FIELDS; f++) probe[f] = settings[f];
  char buf[MAX_BASE_DIR];
  uint32_t n;
  if (!base_dir_value(buf, &n)) {
    scan_loading = 0;
    text_setz(&scan_error, TOO_LONG_BASE);
    scan_view();
    return;
  }
  probe[S_BASE_DIR] = (text){buf, n};
  ask_as(probe, profiles_answered, 0, "GET", "/profiles", WIRE_NONE, 0);
}

static void saved_view(void) {
  if (!shown) return;
  cd_region_hide(&saved_msg);
  if ((!saved_shown && !save_error.len) || !cd_region_show(&saved_msg, 1)) return;
  cd_at(section, saved_slot);
  el(CD_LIT("div"), save_error.len ? CD_LIT("message error") : CD_LIT("message success"));
  cd_name_open(saved_msg.root);
  if (save_error.len) tmp_text(save_error.p, save_error.len);
  else cd_text(CD_LIT("Anki settings saved."));
  cd_close();
  cd_region_end(&saved_msg);
}

/* The install's message, after its button, as React draws it: "<message> (<addons dir>)" in a
 * success box, or the error in an error box. */
static void install_view(void) {
  if (!shown) return;
  cd_set_text(install_text, install_running ? CD_LIT("Installing…") : CD_LIT("Install into Anki"));
  cd_set_bool(install_button, CD_LIT("disabled"), install_running);
  cd_region_hide(&install_msg);
  if (!install_message.len || !cd_region_show(&install_msg, 1)) return;
  cd_at(install_block, 0); /* last in the block, after the button */
  el(CD_LIT("div"), install_ok == 1 ? CD_LIT("message success") : CD_LIT("message error"));
  cd_name_open(install_msg.root);
  tmp_text(install_message.p, install_message.len);
  cd_close();
  cd_region_end(&install_msg);
}

void settings_after(void) {
  scan_view();
  saved_view();
  install_view();
  scan();
}

static void saved_gone(void *ctx) {
  (void)ctx;
  saved_shown = 0;
  saved_view();
}

static void save(void) {
  /* all three read before any is kept: one too long keeps none of them, and says which */
  char base[MAX_BASE_DIR], url[2048], token[2048];
  uint32_t nb, nu, nt;
  const char *too_long = !base_dir_value(base, &nb) ? TOO_LONG_BASE
    : !input_value(url_input, url, sizeof url, &nu) ? "The bridge address is too long"
    : !input_value(token_input, token, sizeof token, &nt) ? "The bridge token is too long"
    : 0;
  text_free(&save_error);
  if (too_long) {
    text_setz(&save_error, too_long);
    saved_shown = 0;
    saved_view();
    return;
  }
  text_set(&draft[S_BASE_DIR], base, nb);
  text_set(&draft[S_BRIDGE_URL], url, nu);
  text_set(&draft[S_BRIDGE_TOKEN], token, nt);
  for (int f = 0; f < S_FIELDS; f++) text_set(&settings[f], draft[f].p, draft[f].len);
  settings_save();
  saved_shown = 1;
  saved_view();
  cd_timer_cb(2000, saved_gone, 0);
  poll_status();
  refresh_decks();
}

static void install(void) {
  install_running = 1;
  install_ok = -1;
  text_free(&install_message);
  install_view();
  char buf[MAX_BASE_DIR];
  uint32_t n;
  if (!base_dir_value(buf, &n)) {
    install_running = 0;
    install_ok = 0;
    text_setz(&install_message, TOO_LONG_BASE);
    install_view();
    return;
  }
  wire_q_install q = {{buf, n}};
  ask(installed_answered, 0, "POST", "/install", WK_Q_INSTALL, &q);
}

ON_EVENT(scan_pressed) {
  if (!scan_loading) scan();
}
ON_EVENT(save_pressed) { save(); }
ON_EVENT(install_pressed) {
  if (!install_running) install();
}

static holder h_answer;
ON_ANSWER(profiles_answered) {
  wire_profiles pr;
  answer a = take(&h_answer, WK_PROFILES, status, p, len, &pr);
  scan_loading = 0;
  for (uint32_t i = 0; i < nprofiles; i++) {
    text_free(&profiles[i].name);
    text_free(&profiles[i].path);
  }
  nprofiles = 0;
  if (a.ok) {
    text_set(&scan_base, pr.base_dir.p, pr.base_dir.len);
    scan_exists = pr.base_dir_exists;
    profiles = cd_realloc(profiles, (pr.nprofiles ? pr.nprofiles : 1) * sizeof *profiles);
    for (uint32_t i = 0; i < pr.nprofiles; i++) {
      profiles[i] = (profile){{0, 0}, {0, 0}};
      text_set(&profiles[i].name, pr.profiles[i].name.p, pr.profiles[i].name.len);
      text_set(&profiles[i].path, pr.profiles[i].collection_path.p, pr.profiles[i].collection_path.len);
    }
    nprofiles = pr.nprofiles;
  } else {
    char m[512];
    text_set(&scan_error, m, answer_message(&a, m, sizeof m));
  }
  scan_view();
}
ON_ANSWER(installed_answered) {
  wire_installed in;
  answer a = take(&h_answer, WK_INSTALLED, status, p, len, &in);
  install_running = 0;
  char m[2048];
  uint32_t n;
  if (a.ok) {
    /* "<message> (<add-ons folder>)" */
    install_ok = 1;
    n = in.message.len < 1500 ? in.message.len : 1500;
    __builtin_memcpy(m, in.message.p, n);
    m[n++] = ' ';
    m[n++] = '(';
    uint32_t d = in.addons_dir.len < 500 ? in.addons_dir.len : 500;
    __builtin_memcpy(m + n, in.addons_dir.p, d);
    n += d;
    m[n++] = ')';
  } else {
    install_ok = 0;
    n = answer_message(&a, m, sizeof m);
  }
  text_set(&install_message, m, n);
  install_view();
  refresh_decks();
}
