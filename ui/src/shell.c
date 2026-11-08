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
void go_replace(const char *path, uint32_t len) {
  cd_url_replace(path, len);
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
  /* A deck that is not in the list. With the collection answering, it is gone (deleted, here or
   * elsewhere) and the page says so. Without (locked, no profile), the list is no evidence either
   * way, and /decks explains what is wrong, as DeckLayout's redirect did. */
  int gone = route == R_DECK && !deck_by_id(route_deck);
  if (gone && !ready()) {
    gone = 0;
    route = R_DECKS;
    cd_url_replace("/decks", 6);
  }
  if (!cd_region_show(&page, 1)) return;
  cd_at(app_content, 0);
  if (route == R_SETTINGS) settings_build();
  else if (route == R_DECKS) decks_build();
  else if (gone) deck_gone_build();
  else deck_build();
  cd_name_open(page.root);
  cd_close();
  cd_region_end(&page);
  if (route == R_DECKS) decks_rows();
  else if (route == R_SETTINGS) settings_after();
  else if (!gone) deck_after();
}

/* Coming back to the tab is when the answer most likely changed: you were just in Anki. As
 * DeckContext did, on the window's focus and on the document showing again (key 1: hidden). */
ON_EVENT(came_back) { poll_status(); }
ON_EVENT(shown_again) {
  if (!e->key) poll_status();
}
ON_EVENT(open_settings) { go("/settings", 9); }

/* ---- every hook cdom calls ---- */
void cd_on_store(uint32_t token, const uint8_t *p, int32_t len) {
  switch (token >> 24) {
  case STORE_SETTINGS: settings_got(p, len); break;
  case STORE_DECK_LANGS: deck_langs_got(token & 0xffffff, p, len); break;
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
  cd_on(CD_DOCUMENT, CD_EV_VISIBILITY, shown_again, 0);
  cd_on(CD_WINDOW, CD_EV_FOCUS, came_back, 0);
  cd_at(CD_MOUNT, 0);
  el(CD_LIT("div"), CD_LIT("App"));
  el(CD_LIT("div"), CD_LIT("app-container"));
  el(CD_LIT("nav"), CD_LIT("navbar"));
  el_text(CD_LIT("div"), CD_LIT("navbar-brand"), CD_LIT("AMGI"));
  el(CD_LIT("div"), CD_LIT("navbar-actions"));
  badge_build(&badges[0]);
  cd_id settings_button = el_id(CD_LIT("button"), CD_LIT("navbar-button action-btn settings-icon"));
  cd_attr(CD_LIT("title"), CD_LIT("Settings"));
  cd_on(settings_button, CD_EV_CLICK, open_settings, 0);
  icon(ICON_COG, ICON_COG_HUB, 0);
  cd_close();
  cd_close();
  cd_close();
  app_content = el_id(CD_LIT("div"), CD_LIT("app-content"));
  cd_close();
  cd_close();
  cd_close();
}
