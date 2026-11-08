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
  cd_store_get(STORE_TOKEN(M_SETTINGS, 1), STORE_KEY, sizeof STORE_KEY - 1, CD_STORE_DEADLINE_MS);
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
  cd_store_put(STORE_TOKEN(M_SETTINGS, 2), STORE_KEY, sizeof STORE_KEY - 1, block, n);
  cd_free(block);
}

/* ---- the screen ---- */
enum { A_BACK = 1, A_INSTALL, A_SCAN, A_SAVE, A_PROFILE };
enum { T_PROFILES = 1, T_INSTALL };
enum { TIMER_SAVED = 1 };

static text draft[S_FIELDS];      /* what the screen shows: the saved settings, then the picks */
typedef struct { text name, path; } profile;
static profile *profiles;
static uint32_t nprofiles;
static int scan_loading, scan_exists = -1, saved_shown, install_running, install_ok = -1;
static text scan_base, scan_error, install_message;
static cd_id section, scan_button, scan_text, install_button, install_text, base_input, url_input, token_input, saved_slot,
  before_bridge, install_block;
static cd_region scan_out = {0};   /* the scan's messages or the profile list, before "Bridge address" */
static cd_region saved_msg = {0};  /* "Anki settings saved." */
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
  cd_id node = cd_id_new();
  cd_open(CD_LIT("input"));
  cd_name(node);
  cd_attr(CD_LIT("id"), cd_internz(id));
  cd_attr(CD_LIT("type"), CD_LIT("text"));
  cd_str v = CD_LIT("value");
  attr_tmp(v, value->p ? value->p : "", value->len);
  cd_attr(CD_LIT("placeholder"), placeholder);
  cd_close();
  return node;
}
static cd_id save_button(uint32_t action, cd_str s, cd_id *txt) {
  cd_id b = cd_id_new();
  el(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("save-button"));
  cd_listen(b, CD_EV_CLICK);
  cd_tag_set(b, TAG(M_SETTINGS, action, 0));
  cd_text(s);
  if (txt) cd_name(*txt = cd_id_new());
  cd_close();
  return b;
}

void settings_build(void) {
  for (int f = 0; f < S_FIELDS; f++) text_set(&draft[f], settings[f].p ? settings[f].p : "", settings[f].len);
  if (!settings_stored || !draft[S_BRIDGE_URL].len) text_setz(&draft[S_BRIDGE_URL], DEFAULT_BRIDGE_URL);
  shown = 1;
  el(CD_LIT("div"), CD_LIT("settings-page"));
  el(CD_LIT("div"), CD_LIT("settings-header"));
  el(CD_LIT("button"), CD_LIT("back-button"));
  listen_click(TAG(M_SETTINGS, A_BACK, 0));
  cd_text(CD_LIT("← Back"));
  cd_close();
  el_text(CD_LIT("h2"), 0, CD_LIT("Settings"));
  cd_close();

  el(CD_LIT("div"), CD_LIT("settings-content"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Anki (local)"));
  el(CD_LIT("div"), CD_LIT("preferences-section"));
  section = cd_id_new();
  cd_name_open(section);

  row_open();
  cd_attr(CD_LIT("style"), CD_LIT("align-items: center;"));
  label(0, CD_LIT("Current mode"));
  badge_build(&badges[1]);
  cd_close();

  el(CD_LIT("div"), CD_LIT("preference-item install-block"));
  install_block = cd_id_new();
  cd_name_open(install_block);
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
  install_button = save_button(A_INSTALL, CD_LIT("Install into Anki"), &install_text);
  cd_close();

  row_open();
  label("ankiBaseDir", CD_LIT("Anki data folder (optional override)"));
  base_input = text_input("ankiBaseDir", &draft[S_BASE_DIR], CD_LIT("Leave blank to use the default Anki2 folder for this OS"));
  cd_close();

  row_open();
  scan_button = save_button(A_SCAN, CD_LIT("Scan for profiles"), &scan_text);
  cd_close();

  row_open();
  before_bridge = cd_id_new();
  cd_name_open(before_bridge);
  label("bridgeUrl", CD_LIT("Bridge address"));
  url_input = text_input("bridgeUrl", &draft[S_BRIDGE_URL], CD_LIT("http://127.0.0.1:8798"));
  cd_close();
  row_open();
  label("bridgeToken", CD_LIT("Bridge token"));
  token_input = text_input("bridgeToken", &draft[S_BRIDGE_TOKEN], CD_LIT("From Anki's Tools > amgi: Bridge status…"));
  cd_close();

  row_open();
  saved_slot = cd_id_new();
  cd_name_open(saved_slot);
  save_button(A_SAVE, CD_LIT("Save Anki settings"), 0);
  cd_close();

  cd_close(); /* .preferences-section */
  cd_close(); /* .settings-content: .settings-page stays open for the shell to close */
}

void settings_forget(void) {
  if (!shown) return;
  shown = 0;
  cd_region_hide(&scan_out);
  cd_region_hide(&saved_msg);
  cd_region_hide(&install_msg);
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
  cd_at(section, before_bridge);
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
      cd_open(CD_LIT("input"));
      cd_attr(CD_LIT("type"), CD_LIT("radio"));
      cd_attr(CD_LIT("name"), CD_LIT("ankiProfile"));
      if (same(profiles[i].path.p, profiles[i].path.len, draft[S_COLLECTION].p, draft[S_COLLECTION].len))
        cd_attr(CD_LIT("checked"), CD_LIT(""));
      listen_as(CD_EV_CHANGE, TAG(M_SETTINGS, A_PROFILE, i));
      cd_close();
      tmp_text(profiles[i].name.p, profiles[i].name.len);
      cd_close();
    }
  }
  cd_close();
  cd_region_end(&scan_out);
}

static void scan(void) {
  scan_loading = 1;
  text_free(&scan_error);
  scan_view();
  /* The typed override, without saving it: a scan is a preview, not a commitment. */
  text probe[S_FIELDS];
  for (int f = 0; f < S_FIELDS; f++) probe[f] = settings[f];
  char buf[1024];
  probe[S_BASE_DIR] = (text){buf, cd_input_value(base_input, buf, sizeof buf)};
  ask_as(probe, M_SETTINGS, T_PROFILES, "GET", "/profiles", WIRE_NONE, 0);
}

static void saved_view(void) {
  if (!shown) return;
  cd_region_hide(&saved_msg);
  if (!saved_shown || !cd_region_show(&saved_msg, 1)) return;
  cd_at(section, saved_slot);
  el(CD_LIT("div"), CD_LIT("message success"));
  cd_name_open(saved_msg.root);
  cd_text(CD_LIT("Anki settings saved."));
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

static void save(void) {
  char buf[2048];
  text_set(&draft[S_BASE_DIR], buf, cd_input_value(base_input, buf, sizeof buf));
  text_set(&draft[S_BRIDGE_URL], buf, cd_input_value(url_input, buf, sizeof buf));
  text_set(&draft[S_BRIDGE_TOKEN], buf, cd_input_value(token_input, buf, sizeof buf));
  for (int f = 0; f < S_FIELDS; f++) text_set(&settings[f], draft[f].p, draft[f].len);
  settings_save();
  saved_shown = 1;
  saved_view();
  cd_timer_start(2000, (uint32_t)M_SETTINGS << 24 | TIMER_SAVED);
  poll_status();
  refresh_decks();
}

static void install(void) {
  install_running = 1;
  install_ok = -1;
  text_free(&install_message);
  install_view();
  char buf[1024];
  wire_q_install q = {{buf, cd_input_value(base_input, buf, sizeof buf)}};
  ask(M_SETTINGS, T_INSTALL, "POST", "/install", WK_Q_INSTALL, &q);
}

void settings_event(const cd_event_rec *e, uint32_t tag) {
  (void)e;
  switch (TAG_ACTION(tag)) {
  case A_BACK: cd_url_step(-1); break;
  case A_SCAN: if (!scan_loading) scan(); break;
  case A_SAVE: save(); break;
  case A_INSTALL: if (!install_running) install(); break;
  case A_PROFILE: {
    uint32_t i = TAG_INDEX(tag);
    if (i < nprofiles) {
      text_set(&draft[S_COLLECTION], profiles[i].path.p, profiles[i].path.len);
      text_set(&draft[S_PROFILE], profiles[i].name.p, profiles[i].name.len);
    }
    break;
  }
  }
}

void settings_timer(uint32_t token) {
  if (token != TIMER_SAVED) return;
  saved_shown = 0;
  saved_view();
}

static holder h_answer;
void settings_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (token == T_PROFILES) {
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
  } else if (token == T_INSTALL) {
    wire_installed in;
    answer a = take(&h_answer, WK_INSTALLED, status, p, len, &in);
    install_running = 0;
    char m[1024];
    uint32_t n;
    if (a.ok) {
      install_ok = 1;
      n = in.message.len < 900 ? in.message.len : 900;
      __builtin_memcpy(m, in.message.p, n);
      m[n++] = ' ';
      m[n++] = '(';
      uint32_t d = in.addons_dir.len < 100 ? in.addons_dir.len : 100;
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
}
