/* The shell: .App > .app-container > nav.navbar + .app-content (AppShell and Navbar), routing in C
 * (/decks, /settings, /deck/<id>), and every hook cdom calls, handed to the module that owns it. */
#include "app.h"

uint32_t route = R_DECKS;
int64_t route_deck;
cd_id app_content;
static cd_region page = {0};
cd_id page_root(void) { return page.shown ? page.root : 0; }

static int parse_route(const char *p, uint32_t len) {
  uint32_t end = 0;
  while (end < len && p[end] != '?' && p[end] != '#') end++;
  if (same_z(p, end, "/settings")) return route = R_SETTINGS, 1;
  if (same_z(p, end, "/decks")) return route = R_DECKS, 1;
  if (end > 6 && same(p, 6, "/deck/", 6)) {
    int64_t id = dec_id(p + 6, end - 6);
    if (id < 0) return 0;
    route_deck = id;
    return route = R_DECK, 1;
  }
  return 0;
}

void go(const char *path, uint32_t len) {
  cd_url_push(path, len);
  parse_route(path, len);
  page_show();
}
void go_deck(int64_t id) {
  char path[32] = "/deck/";
  go(path, 6 + id_dec(path + 6, id));
}
void cd_on_url(const uint8_t *path, uint32_t len) {
  if (!parse_route((const char *)path, len)) route = R_DECKS;
  page_show();
}

static void page_hide(void) {
  decks_forget();
  settings_forget();
  deck_forget();
  cd_region_hide(&page);
  badges[1] = (badge){0, 0, 0};
}

/* Builds the screen for route under .app-content, as one element the page region owns. Nothing
 * until the settings and the first decks answer are in: the React app's first frames drew the setup
 * screen over a collection that was fine (its mode starts "unconfigured"). */
void page_show(void) {
  page_hide();
  if (!settings_loaded || (route != R_SETTINGS && !decks_known)) return;
  /* A deck that is not in the list: DeckLayout sent you back to /decks. */
  if (route == R_DECK && !deck_by_id(route_deck)) {
    route = R_DECKS;
    cd_url_replace("/decks", 6);
  }
  if (!cd_region_show(&page, 1)) return;
  cd_at(app_content, 0);
  if (route == R_SETTINGS) settings_build();
  else if (route == R_DECKS) decks_build();
  else deck_build();
  cd_name_open(page.root);
  cd_close();
  cd_region_end(&page);
  if (route == R_DECKS) decks_rows();
  else if (route == R_SETTINGS) settings_after();
  else deck_after();
}

/* ---- every hook cdom calls ---- */
void cd_on_event(const cd_event_rec *e) {
  /* Coming back to the tab is when the answer most likely changed: you were just in Anki. As
   * DeckContext did, on the window's focus and on the document showing again (key 1: hidden). */
  if (e->type == CD_EV_VISIBILITY || (e->type == CD_EV_FOCUS && (cd_id)e->id == CD_WINDOW)) {
    if (e->type == CD_EV_FOCUS || !e->key) poll_status();
    return;
  }
  uint32_t tag = cd_tag((cd_id)e->id);
  switch (TAG_MODULE(tag)) {
  case M_SHELL: go("/settings", 9); break;
  case M_DECKS: decks_event(e, tag); break;
  case M_SETTINGS: settings_event(e, tag); break;
  case M_DECK: case M_FORM: case M_PANEL: case M_BULK: deck_event(e, tag); break;
  case M_MODAL: modal_event(e, tag); break;
  case M_FIRSTRUN: firstrun_event(tag); break;
  case M_STARTER: if (e->type == CD_EV_CLICK || e->type == CD_EV_CHANGE) starter_event(tag); break;
  case M_TEMPLATE: template_event(tag); break;
  case M_CHIP: if (e->type == CD_EV_CLICK) chip_event(tag); break;
  }
}

void cd_on_timer(uint32_t token) {
  switch (token >> 24) {
  case M_SHELL: state_timer(token & 0xffffff); break;
  case M_SETTINGS: settings_timer(token & 0xffffff); break;
  }
}

void cd_on_store(uint32_t token, const uint8_t *p, int32_t len) {
  switch (token >> 24) {
  case M_SETTINGS: settings_got(p, len); break;
  case M_DECK: deck_langs_got(token & 0xffffff, p, len); break;
  }
}

void cd_on_audio_loaded(uint32_t token, uint32_t clip) { chips_audio_loaded(token, clip); }
void cd_on_audio_ended(uint32_t voice) { chips_audio_ended(voice); }

void cd_main(void) {
  settings_load();
  char path[512];
  uint32_t len = cd_url_read(CD_URL_ALL, path, sizeof path);
  if (len > sizeof path || !parse_route(path, len)) {
    route = R_DECKS;
    cd_url_replace("/decks", 6);
  }
  cd_listen_window(CD_EV_VISIBILITY);
  cd_listen(CD_WINDOW, CD_EV_FOCUS);
  app_content = cd_id_new();
  cd_at(CD_MOUNT, 0);
  el(CD_LIT("div"), CD_LIT("App"));
  el(CD_LIT("div"), CD_LIT("app-container"));
  el(CD_LIT("nav"), CD_LIT("navbar"));
  el_text(CD_LIT("div"), CD_LIT("navbar-brand"), CD_LIT("AMGI"));
  el(CD_LIT("div"), CD_LIT("navbar-actions"));
  badge_build(&badges[0]);
  el(CD_LIT("button"), CD_LIT("navbar-button action-btn settings-icon"));
  cd_attr(CD_LIT("title"), CD_LIT("Settings"));
  listen_click(TAG(M_SHELL, 1, 0));
  icon(ICON_COG, ICON_COG_HUB, 0);
  cd_close();
  cd_close();
  cd_close();
  el(CD_LIT("div"), CD_LIT("app-content"));
  cd_name_open(app_content);
  cd_close();
  cd_close();
  cd_close();
}
