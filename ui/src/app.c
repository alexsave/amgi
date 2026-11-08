/* amgi's UI in C on cdom, phase 0's spike: the navbar with the Anki mode badge, the deck list and
 * the Settings screen, routed in C (/decks, /settings, /deck/<id>), over the app's unchanged CSS.
 * The DOM is the React app's own (src/components/Navigation, Deck, Settings), element for element
 * and class for class, so the same stylesheet draws the same page.
 *
 * State lives here, as DeckContext held it: the transport mode (polled every 4 s and when the tab
 * shows again), whether amgi is installed, the decks. Every answer from /api/anki crosses in amgi's
 * wire format (ui/wire/wire.h), and the settings cross as the five plain headers that
 * src/server/anki/settings.js reads; they are kept in cdom_store as that same header block. */
#include "cdom.h"
#include "cdom_net.h"
#include "cdom_store.h"
#include "cdom_url.h"
#include "../wire/wire.h"

uint8_t *wire_grow(uint8_t *p, uint32_t len, uint32_t cap) {
  (void)len;
  return cd_realloc(p, cap);
}

/* ---- small text helpers ---- */
static uint32_t zlen(const char *s) {
  uint32_t n = 0;
  while (s[n]) n++;
  return n;
}
static int same(const char *a, uint32_t alen, const char *b, uint32_t blen) {
  if (alen != blen) return 0;
  for (uint32_t i = 0; i < alen; i++)
    if (a[i] != b[i]) return 0;
  return 1;
}
static int starts(const char *s, uint32_t len, const char *prefix) {
  uint32_t n = zlen(prefix);
  return len >= n && same(s, n, prefix, n);
}
/* A deck id (positive, past 2^32) in decimal; returns the digits written (at most 20). */
static uint32_t id_dec(char *dst, int64_t id) {
  char digits[20];
  uint32_t k = 0, n = 0;
  do digits[k++] = (char)('0' + id % 10); while ((id /= 10) > 0);
  while (k) dst[n++] = digits[--k];
  return n;
}
/* An owned copy of some bytes (freed by the next copy into the same slot). */
typedef struct { char *p; uint32_t len; } text;
static void text_set(text *t, const char *p, uint32_t len) {
  cd_free(t->p);
  t->p = cd_alloc(len + 1);
  if (len) __builtin_memcpy(t->p, p, len);
  t->p[len] = 0;
  t->len = len;
}

/* ---- the settings: five facts, kept and sent as the header block the server reads ---- */
enum { S_BASE_DIR, S_COLLECTION, S_PROFILE, S_BRIDGE_URL, S_BRIDGE_TOKEN, S_FIELDS };
static const char *const S_HEADERS[S_FIELDS] = {
  "X-Amgi-Base-Dir", "X-Amgi-Collection", "X-Amgi-Profile", "X-Amgi-Bridge-Url", "X-Amgi-Bridge-Token",
};
#define STORE_KEY "amgi:anki-settings:1"
#define DEFAULT_BRIDGE_URL "http://127.0.0.1:8798"
static text settings[S_FIELDS];
static int settings_stored; /* the store had a block: without one the server reads the defaults */
static int settings_loaded; /* the store has answered */

/* encodeURIComponent: every byte but A-Z a-z 0-9 - _ . ! ~ * ' ( ) as %XX. */
static uint32_t pct_encode(char *dst, const char *s, uint32_t len) {
  static const char HEX[] = "0123456789ABCDEF";
  uint32_t n = 0;
  for (uint32_t i = 0; i < len; i++) {
    uint8_t c = (uint8_t)s[i];
    int keep = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
               c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')';
    if (keep) {
      dst[n++] = (char)c;
    } else {
      dst[n++] = '%';
      dst[n++] = HEX[c >> 4];
      dst[n++] = HEX[c & 15];
    }
  }
  return n;
}
static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
static uint32_t pct_decode(char *dst, const char *s, uint32_t len) {
  uint32_t n = 0;
  for (uint32_t i = 0; i < len; i++) {
    int hi, lo;
    if (s[i] == '%' && i + 2 < len && (hi = hexval(s[i + 1])) >= 0 && (lo = hexval(s[i + 2])) >= 0) {
      dst[n++] = (char)(hi << 4 | lo);
      i += 2;
    } else {
      dst[n++] = s[i];
    }
  }
  return n;
}

/* The settings as header lines into dst (room for 3 bytes a value byte plus the names); returns the
 * bytes written. */
static uint32_t settings_block(char *dst, const text *s) {
  uint32_t n = 0;
  for (int f = 0; f < S_FIELDS; f++) {
    uint32_t k = zlen(S_HEADERS[f]);
    __builtin_memcpy(dst + n, S_HEADERS[f], k);
    n += k;
    dst[n++] = ':';
    dst[n++] = ' ';
    n += pct_encode(dst + n, s[f].p ? s[f].p : "", s[f].len);
    dst[n++] = '\n';
  }
  return n;
}
static uint32_t settings_room(const text *s) {
  uint32_t n = 0;
  for (int f = 0; f < S_FIELDS; f++) n += zlen(S_HEADERS[f]) + 3 + 3 * s[f].len;
  return n;
}
/* A stored block back into the five fields. */
static void settings_read(const uint8_t *p, uint32_t len) {
  const char *s = (const char *)p, *end = s + len;
  while (s < end) {
    const char *eol = s;
    while (eol < end && *eol != '\n') eol++;
    for (int f = 0; f < S_FIELDS; f++) {
      uint32_t k = zlen(S_HEADERS[f]);
      if ((uint32_t)(eol - s) >= k + 2 && same(s, k, S_HEADERS[f], k) && s[k] == ':' && s[k + 1] == ' ') {
        uint32_t vlen = (uint32_t)(eol - s) - k - 2;
        char *buf = cd_alloc(vlen + 1);
        text_set(&settings[f], buf, pct_decode(buf, s + k + 2, vlen));
        cd_free(buf);
      }
    }
    s = eol + 1;
  }
}

/* ---- requests ---- */
enum { T_STATUS = 1, T_DECKS, T_INSTALL, T_PROFILES, T_STORE_GET, T_STORE_PUT };
#define ACCEPT "Accept: " WIRE_MIME "\n"
#define DEADLINE_MS 15000

/* GET /api/anki<path> with the settings s (NULL: the saved ones), answered in cd_on_http(token). */
static void get(uint32_t token, const char *path, const text *s) {
  static const char PREFIX[] = "/api/anki";
  char url[128];
  uint32_t plen = zlen(path);
  __builtin_memcpy(url, PREFIX, sizeof PREFIX - 1);
  __builtin_memcpy(url + sizeof PREFIX - 1, path, plen);
  const text *use = s ? s : settings;
  uint32_t room = (uint32_t)sizeof ACCEPT + settings_room(use);
  char *headers = cd_alloc(room);
  uint32_t hlen = sizeof ACCEPT - 1;
  __builtin_memcpy(headers, ACCEPT, hlen);
  if (s || settings_stored) hlen += settings_block(headers + hlen, use);
  cd_http(token, "GET", 3, url, (uint32_t)sizeof PREFIX - 1 + plen, headers, hlen, 0, 0, DEADLINE_MS);
  cd_free(headers);
}

/* ---- the state DeckContext held ---- */
typedef struct { int64_t id; uint32_t count; cd_str name; } deck;
static deck *decks;
static uint32_t ndecks, decks_cap;
static int decks_known;       /* a decks answer has come (React's loading = false) */
static uint32_t mode = WIRE_MODE_UNCONFIGURED;
static int status_seen;       /* the first status answer is the page loading */
static int installed = -1;    /* -1 unknown, 0 no, 1 yes */
static int ready(void) { return mode == WIRE_MODE_DIRECT || mode == WIRE_MODE_BRIDGE; }

/* ---- the mode badge: src/utils/ankiModeText.js's table ---- */
typedef struct { const char *label, *color, *title; } presentation;
static const presentation PRESENT[WIRE_MODES] = {
  [WIRE_MODE_DIRECT] = {"Anki connected", "#4caf50", "Reading your Anki collection file directly - Anki is closed."},
  [WIRE_MODE_BRIDGE] = {"Anki connected", "#4caf50", "Reading your live collection through the Anki bridge add-on."},
  [WIRE_MODE_LOCKED] = {"Anki locked", "#e07050",
                        "Anki is open and the bridge is not reachable, so your collection cannot be read right now. "
                        "Close Anki, or start the bridge (Tools > amgi: Bridge status...) and paste its token into Settings."},
  [WIRE_MODE_BRIDGE_NO_COLLECTION] = {"Anki: no profile", "#e07050",
                                      "The bridge is running but no Anki profile is open yet - pick one in Anki."},
  [WIRE_MODE_NOT_FOUND] = {"Anki: not found", "#e07050",
                           "No collection.anki2 was found at the selected profile. Open Settings to pick a different one."},
  [WIRE_MODE_UNSUPPORTED_SCHEMA] = {"Anki: unsupported", "#e07050",
                                    "This collection uses a schema version amgi does not support yet."},
  [WIRE_MODE_UNCONFIGURED] = {"Anki: not set up yet", "#808080", "amgi has not been installed into Anki on this machine yet."},
  [WIRE_MODE_OTHER] = {"Anki: not set up yet", "#808080", "amgi has not been installed into Anki on this machine yet."},
};
static const presentation *present(uint32_t m) { return &PRESENT[m < WIRE_MODES ? m : WIRE_MODE_OTHER]; }
static const presentation *badge_now(void) { return present(installed == 0 ? WIRE_MODE_UNCONFIGURED : mode); }

#define BADGES 2
typedef struct { cd_id span, dot, label; } badge;
static badge badges[BADGES]; /* the navbar's, and the Settings screen's "Current mode" */

static char style_buf[96];
static uint32_t dot_style(const char *color) {
  static const char A[] = "width: 7px; height: 7px; border-radius: 50%; background: ";
  static const char B[] = "; flex-shrink: 0;";
  uint32_t n = 0, c = zlen(color);
  __builtin_memcpy(style_buf, A, sizeof A - 1);
  n += sizeof A - 1;
  __builtin_memcpy(style_buf + n, color, c);
  n += c;
  __builtin_memcpy(style_buf + n, B, sizeof B - 1);
  return n + sizeof B - 1;
}

/* AnkiModeBadge, built where cd_at points or inside the open element. */
static void badge_build(badge *b) {
  const presentation *p = badge_now();
  b->span = cd_id_new();
  b->dot = cd_id_new();
  b->label = cd_id_new();
  cd_open(CD_LIT("span"));
  cd_name(b->span);
  cd_attr(CD_LIT("title"), cd_internz(p->title));
  cd_attr(CD_LIT("style"), CD_LIT("display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.7rem; "
                                  "font-weight: 600; letter-spacing: 0.02em; border: 1px solid var(--border-color); "
                                  "border-radius: 999px; padding: 0.2rem 0.6rem; color: var(--text-secondary); "
                                  "white-space: nowrap;"));
  cd_open(CD_LIT("span"));
  cd_name(b->dot);
  cd_str style = CD_LIT("style");
  cd_attr(style, cd_tmp(style_buf, dot_style(p->color)));
  cd_close();
  cd_text(cd_internz(p->label));
  cd_name(b->label);
  cd_close();
}
static void badges_update(void) {
  const presentation *p = badge_now();
  for (int i = 0; i < BADGES; i++) {
    badge *b = &badges[i];
    if (!b->span) continue;
    cd_set_attr(b->span, CD_LIT("title"), cd_internz(p->title));
    cd_str style = CD_LIT("style");
    cd_set_attr(b->dot, style, cd_tmp(style_buf, dot_style(p->color)));
    cd_set_text(b->label, cd_internz(p->label));
  }
}

/* ---- icons (heroicons 24/outline, as @heroicons/react renders them) ---- */
static void icon(const char *d1, const char *d2, cd_str style) {
  cd_open(CD_LIT("svg"));
  cd_attr(CD_LIT("xmlns"), CD_LIT("http://www.w3.org/2000/svg"));
  cd_attr(CD_LIT("fill"), CD_LIT("none"));
  cd_attr(CD_LIT("viewBox"), CD_LIT("0 0 24 24"));
  cd_attr(CD_LIT("stroke-width"), CD_LIT("1.5"));
  cd_attr(CD_LIT("stroke"), CD_LIT("currentColor"));
  cd_attr(CD_LIT("aria-hidden"), CD_LIT("true"));
  cd_attr(CD_LIT("data-slot"), CD_LIT("icon"));
  if (style) cd_attr(CD_LIT("style"), style);
  for (int i = 0; i < 2; i++) {
    const char *d = i ? d2 : d1;
    if (!d) continue;
    cd_open(CD_LIT("path"));
    cd_attr(CD_LIT("stroke-linecap"), CD_LIT("round"));
    cd_attr(CD_LIT("stroke-linejoin"), CD_LIT("round"));
    cd_attr(CD_LIT("d"), cd_internz(d));
    cd_close();
  }
  cd_close();
}
static const char COG[] =
  "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083."
  "22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003."
  "827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1."
  "298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.5"
  "81.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.6"
  "86-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2."
  "247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43"
  "-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.07"
  "6-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z";
static const char COG_HUB[] = "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z";
static const char PLUS[] = "M12 4.5v15m7.5-7.5h-15";

/* ---- events: what each listening node is, by its tag ---- */
enum { TAG_SETTINGS = 1, TAG_NEW_DECK, TAG_BACK, TAG_SCAN, TAG_SAVE, TAG_INSTALL, TAG_DECK = 0x100, TAG_PROFILE = 0x10000 };
static void listen_click(uint32_t tag) {
  cd_id id = cd_id_new();
  cd_listen(id, CD_EV_CLICK);
  cd_tag_set(id, tag);
}

/* ---- routes ---- */
enum { R_DECKS, R_SETTINGS, R_DECK };
static uint32_t route = R_DECKS;
static int64_t route_deck;
static cd_id app_content;
static cd_region page = {0};    /* the screen: one element under .app-content */
static cd_region list = {0};    /* the deck list's rows: all the children of .deck-list (its parent) */
static cd_id deck_list_node;    /* .deck-list, while the decks screen shows */
static void page_show(void);

static int parse_route(const char *p, uint32_t len) {
  uint32_t end = 0;
  while (end < len && p[end] != '?' && p[end] != '#') end++;
  if (same(p, end, "/settings", 9)) return route = R_SETTINGS, 1;
  if (same(p, end, "/decks", 6)) return route = R_DECKS, 1;
  if (starts(p, end, "/deck/") && end > 6) {
    int64_t id = 0;
    for (uint32_t i = 6; i < end; i++) {
      if (p[i] < '0' || p[i] > '9') return 0;
      id = id * 10 + (p[i] - '0');
    }
    route_deck = id;
    return route = R_DECK, 1;
  }
  return 0;
}
static void go(const char *path, uint32_t len) {
  cd_url_push(path, len);
  parse_route(path, len);
  page_show();
}
void cd_on_url(const uint8_t *path, uint32_t len) {
  if (!parse_route((const char *)path, len)) route = R_DECKS;
  page_show();
}

/* ---- the decks screen (DeckList, DeckItem) ---- */
static void list_rows(void) {
  if (!deck_list_node) return;
  cd_region_hide(&list);
  if (!cd_region_show(&list, 1)) return;
  cd_at(deck_list_node, 0);
  if (!ready()) {
    cd_open(CD_LIT("div"));
    cd_class(CD_LIT("empty-deck-state"));
    cd_open(CD_LIT("p"));
    cd_attr(CD_LIT("style"), CD_LIT("max-width: 32rem; text-align: center; color: var(--text-secondary);"));
    cd_text(cd_internz(present(mode)->title));
    cd_close();
    cd_close();
  } else if (!decks_known) {
    cd_open(CD_LIT("div"));
    cd_class(CD_LIT("deck-list-loading"));
    cd_text(CD_LIT("Loading your decks…"));
    cd_close();
  } else if (!ndecks) {
    cd_open(CD_LIT("div"));
    cd_class(CD_LIT("empty-deck-state"));
    cd_open(CD_LIT("button"));
    cd_class(CD_LIT("create-first-deck-btn"));
    listen_click(TAG_NEW_DECK);
    icon(PLUS, 0, CD_LIT("height: 20px; width: 20px;"));
    cd_open(CD_LIT("span"));
    cd_text(CD_LIT("Create your first deck"));
    cd_close();
    cd_close();
    cd_close();
  } else {
    for (uint32_t i = 0; i < ndecks; i++) {
      cd_open(CD_LIT("div"));
      cd_class(CD_LIT("deck-item"));
      listen_click(TAG_DECK + i);
      cd_open(CD_LIT("div"));
      cd_class(CD_LIT("deck-info"));
      cd_open(CD_LIT("h3"));
      cd_text(decks[i].name);
      cd_close();
      cd_open(CD_LIT("small"));
      /* Three text nodes, as DeckItem's JSX makes them: the browser shapes text node by text
       * node, and "3 notes" as one run kerns the "3" 1 px from where React's "3" + " note" + "s"
       * draws it. */
      cd_text_num(decks[i].count);
      cd_text(CD_LIT(" note"));
      if (decks[i].count != 1) cd_text(CD_LIT("s"));
      cd_close();
      cd_close();
      cd_close();
    }
  }
  cd_region_end(&list);
}

static void decks_build(void) {
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("deck-management"));
  cd_name_open(page.root);
  /* Setup is the whole screen (FirstRun), not an empty state inside the list. */
  if (installed == 0 || mode == WIRE_MODE_UNCONFIGURED) {
    cd_open(CD_LIT("div"));
    cd_class(CD_LIT("first-run"));
    cd_text(CD_LIT("FirstRun is not ported in phase 0."));
    cd_close();
    cd_close();
    return;
  }
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("deck-header"));
  cd_open(CD_LIT("h2"));
  cd_text(CD_LIT("Decks"));
  cd_close();
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("deck-actions"));
  cd_open(CD_LIT("button"));
  cd_class(CD_LIT("action-btn"));
  cd_attr(CD_LIT("title"), CD_LIT("New Deck"));
  listen_click(TAG_NEW_DECK);
  icon(PLUS, 0, 0);
  cd_close();
  cd_close();
  cd_close();
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("deck-list"));
  deck_list_node = cd_id_new();
  cd_name_open(deck_list_node);
  list.parent = deck_list_node; /* the rows are all its children */
  cd_close();
  cd_close();
}

/* ---- the Settings screen (Settings, AnkiSetupPanel) ---- */
static text draft[S_FIELDS];      /* what the screen shows: the saved settings, then the picks */
typedef struct { text name, path; } profile;
static profile *profiles;
static uint32_t nprofiles;
static int scan_loading, scan_exists = -1, saved_shown;
static text scan_base;
static cd_id section, scan_button, scan_text, base_input, url_input, token_input, saved_slot, before_bridge;
static cd_region scan_out = {0};  /* the scan's messages or the profile list, before "Bridge address" */
static cd_region saved_msg = {0}; /* "Anki settings saved." */

static void row_open(void) {
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("preference-item"));
}
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
  cd_attr(v, cd_tmp(value->p ? value->p : "", value->len));
  cd_attr(CD_LIT("placeholder"), placeholder);
  cd_close();
  return node;
}

static void settings_build(void) {
  for (int f = 0; f < S_FIELDS; f++) text_set(&draft[f], settings[f].p ? settings[f].p : "", settings[f].len);
  if (!settings_stored || !draft[S_BRIDGE_URL].len) text_set(&draft[S_BRIDGE_URL], DEFAULT_BRIDGE_URL, sizeof DEFAULT_BRIDGE_URL - 1);
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("settings-page"));
  cd_name_open(page.root);
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("settings-header"));
  cd_open(CD_LIT("button"));
  cd_class(CD_LIT("back-button"));
  listen_click(TAG_BACK);
  cd_text(CD_LIT("← Back"));
  cd_close();
  cd_open(CD_LIT("h2"));
  cd_text(CD_LIT("Settings"));
  cd_close();
  cd_close();

  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("settings-content"));
  cd_open(CD_LIT("h3"));
  cd_text(CD_LIT("Anki (local)"));
  cd_close();
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("preferences-section"));
  section = cd_id_new();
  cd_name_open(section);

  row_open();
  cd_attr(CD_LIT("style"), CD_LIT("align-items: center;"));
  label(0, CD_LIT("Current mode"));
  badge_build(&badges[1]);
  cd_close();

  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("preference-item install-block"));
  label(0, CD_LIT("Install amgi into Anki"));
  cd_open(CD_LIT("p"));
  cd_class(CD_LIT("preference-help"));
  cd_text(CD_LIT("Adds amgi’s microphone and bridge add-ons, and the “amgi Listening” note type, to the Anki on this "
                 "machine. Safe to run again to update them."));
  cd_close();
  cd_open(CD_LIT("p"));
  cd_class(CD_LIT("preference-help"));
  cd_text(CD_LIT("Installs into "));
  cd_open(CD_LIT("code"));
  if (draft[S_BASE_DIR].len) cd_text(cd_tmp(draft[S_BASE_DIR].p, draft[S_BASE_DIR].len));
  else cd_text(CD_LIT("your default Anki data folder"));
  cd_close();
  if (!draft[S_BASE_DIR].len) cd_text(CD_LIT(" - set the override below to install somewhere else."));
  cd_close();
  cd_open(CD_LIT("button"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("save-button"));
  listen_click(TAG_INSTALL);
  cd_text(CD_LIT("Install into Anki"));
  cd_close();
  cd_close();

  row_open();
  label("ankiBaseDir", CD_LIT("Anki data folder (optional override)"));
  base_input = text_input("ankiBaseDir", &draft[S_BASE_DIR], CD_LIT("Leave blank to use the default Anki2 folder for this OS"));
  cd_close();

  row_open();
  scan_button = cd_id_new();
  cd_open(CD_LIT("button"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("save-button"));
  cd_listen(scan_button, CD_EV_CLICK);
  cd_tag_set(scan_button, TAG_SCAN);
  cd_text(CD_LIT("Scan for profiles"));
  scan_text = cd_id_new();
  cd_name(scan_text);
  cd_close();
  cd_close();

  /* The scan's messages and the profile list go here (settings_scan_view). */
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
  cd_open(CD_LIT("button"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("save-button"));
  listen_click(TAG_SAVE);
  cd_text(CD_LIT("Save Anki settings"));
  cd_close();
  cd_close();

  cd_close(); /* .preferences-section */
  cd_close(); /* .settings-content */
  cd_close(); /* .settings-page */
}

/* The scan's part of the screen, rebuilt whenever the scan changes: the loading label, then (once
 * it is done) the missing-folder or no-profile message, or the profile radios. */
static void settings_scan_view(void) {
  if (!page.shown || route != R_SETTINGS) return;
  cd_set_text(scan_text, scan_loading ? CD_LIT("Scanning…") : CD_LIT("Scan for profiles"));
  /* React also disables the button while it scans; cdom cannot take an attribute away (a gap), so
   * the click is ignored instead (cd_on_event). */
  cd_region_hide(&scan_out);
  if (scan_loading) return;
  int none = scan_exists == 1 && !nprofiles, missing = scan_exists == 0;
  if (!none && !missing && !nprofiles) return;
  if (!cd_region_show(&scan_out, 1)) return;
  cd_at(section, before_bridge);
  cd_open(CD_LIT("div"));
  cd_name_open(scan_out.root);
  if (missing) {
    cd_class(CD_LIT("message error"));
    cd_text(CD_LIT("No Anki data folder was found at "));
    cd_open(CD_LIT("code"));
    cd_text(cd_tmp(scan_base.p ? scan_base.p : "", scan_base.len));
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
      cd_id radio = cd_id_new();
      cd_listen(radio, CD_EV_CHANGE);
      cd_tag_set(radio, TAG_PROFILE + i);
      cd_close();
      cd_text(cd_tmp(profiles[i].name.p, profiles[i].name.len));
      cd_close();
    }
  }
  cd_close();
  cd_region_end(&scan_out);
}

static void scan(void) {
  scan_loading = 1;
  settings_scan_view();
  /* The typed override, without saving it: a scan is a preview. */
  text probe[S_FIELDS];
  for (int f = 0; f < S_FIELDS; f++) probe[f] = settings[f];
  char buf[1024];
  uint32_t n = cd_input_value(base_input, buf, sizeof buf);
  text typed = {buf, n};
  probe[S_BASE_DIR] = typed;
  get(T_PROFILES, "/profiles", probe);
}

static void saved_view(void) {
  if (!page.shown || route != R_SETTINGS) return;
  cd_region_hide(&saved_msg);
  if (!saved_shown || !cd_region_show(&saved_msg, 1)) return;
  cd_at(section, saved_slot);
  cd_open(CD_LIT("div"));
  cd_name_open(saved_msg.root);
  cd_class(CD_LIT("message success"));
  cd_text(CD_LIT("Anki settings saved."));
  cd_close();
  cd_region_end(&saved_msg);
}

/* ---- screens ---- */
static void page_hide(void) {
  cd_region_hide(&scan_out);
  cd_region_hide(&saved_msg);
  cd_region_hide(&list);
  cd_region_hide(&page);
  badges[1] = (badge){0, 0, 0};
  deck_list_node = 0;
}

static void page_show(void) {
  page_hide();
  /* Nothing until the first decks answer: the React app's first frames drew the setup screen
   * over a collection that was fine (its mode starts "unconfigured"). */
  if (!settings_loaded || (!decks_known && route == R_DECKS)) return;
  if (!cd_region_show(&page, 1)) return;
  cd_at(app_content, 0);
  if (route == R_SETTINGS) {
    settings_build();
  } else if (route == R_DECKS) {
    decks_build();
  } else {
    cd_open(CD_LIT("div"));
    cd_class(CD_LIT("deck-management"));
    cd_name_open(page.root);
    cd_open(CD_LIT("h2"));
    char name[24];
    cd_text(cd_tmp(name, id_dec(name, route_deck)));
    cd_close();
    cd_open(CD_LIT("p"));
    cd_text(CD_LIT("The deck screen is not ported in phase 0."));
    cd_close();
    cd_close();
  }
  cd_region_end(&page);
  if (route == R_DECKS) list_rows();
  if (route == R_SETTINGS) {
    settings_scan_view();
    saved_view();
    scan();
  }
}

/* ---- polling and answers ---- */
#define POLL_MS 4000
enum { TIMER_POLL = 1, TIMER_SAVED };

static void refresh_decks(void) { get(T_DECKS, "/decks", 0); }
static void poll_status(void) { get(T_STATUS, "/status", 0); }

static void set_mode(uint32_t m) {
  if (m == mode) return;
  mode = m;
  badges_update();
}

static void on_status(const uint8_t *p, uint32_t len) {
  wire_status s;
  if (!wire_read_status(p, len, &s)) return;
  int changed = !status_seen || s.mode != mode;
  int first = !status_seen;
  status_seen = 1;
  set_mode(s.mode);
  /* A change of mode is the event: the decks it implies are fetched again. */
  if (changed && !first) refresh_decks();
}

static void on_decks(uint32_t status, const uint8_t *p, uint32_t len) {
  wire_in in;
  wire_deck d;
  uint32_t m, n;
  int was_known = decks_known;
  decks_known = 1;
  if (status == 200 && wire_decks_check(p, len) && wire_decks_open(&in, p, len, &m, &n)) {
    if (n > decks_cap) {
      decks_cap = n;
      decks = cd_realloc(decks, n * sizeof *decks);
    }
    ndecks = 0;
    while (wire_decks_next(&in, &d)) decks[ndecks++] = (deck){d.id, d.note_count, cd_intern(d.name.p, d.name.len)};
    set_mode(m);
    get(T_INSTALL, "/install", 0);
  } else {
    wire_error e;
    set_mode(wire_read_error(p, len, &e) && e.mode != WIRE_MODE_OTHER ? e.mode : WIRE_MODE_UNCONFIGURED);
  }
  if (route == R_DECKS) {
    if (!was_known) page_show();
    else list_rows();
  }
}

static void on_install(uint32_t status, const uint8_t *p, uint32_t len) {
  wire_install s;
  int was = installed;
  /* An answer that is not one counts as installed, as DeckContext's catch did. */
  installed = status == 200 && wire_read_install(p, len, &s) ? (int)s.installed : 1;
  if (installed == was) return;
  badges_update();
  /* Not installed is the setup screen: only a change across that redraws the screen. */
  if (route == R_DECKS && (installed == 0) != (was == 0)) page_show();
}

static void on_profiles(uint32_t status, const uint8_t *p, uint32_t len) {
  wire_in in;
  wire_str base;
  wire_profile pr;
  uint32_t exists, n;
  scan_loading = 0;
  for (uint32_t i = 0; i < nprofiles; i++) {
    cd_free(profiles[i].name.p);
    cd_free(profiles[i].path.p);
  }
  nprofiles = 0;
  if (status == 200 && wire_profiles_open(&in, p, len, &base, &exists, &n)) {
    text_set(&scan_base, base.p, base.len);
    scan_exists = (int)exists;
    profiles = cd_realloc(profiles, (n ? n : 1) * sizeof *profiles);
    while (wire_profiles_next(&in, &pr)) {
      profile *q = &profiles[nprofiles++];
      q->name = (text){0, 0};
      q->path = (text){0, 0};
      text_set(&q->name, pr.name.p, pr.name.len);
      text_set(&q->path, pr.collection_path.p, pr.collection_path.len);
    }
  }
  settings_scan_view();
}

void cd_on_http(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  switch (token) {
  case T_STATUS: if (status == 200) on_status(p, len); break;
  case T_DECKS: on_decks(status, p, len); break;
  case T_INSTALL: on_install(status, p, len); break;
  case T_PROFILES: on_profiles(status, p, len); break;
  }
}

void cd_on_timer(uint32_t token) {
  if (token == TIMER_POLL) {
    poll_status();
    cd_timer_start(POLL_MS, TIMER_POLL);
  } else if (token == TIMER_SAVED) {
    saved_shown = 0;
    saved_view();
  }
}

static void loaded(void) {
  settings_loaded = 1;
  page_show();
  poll_status();
  refresh_decks();
  cd_timer_start(POLL_MS, TIMER_POLL);
}

void cd_on_store(uint32_t token, const uint8_t *p, int32_t len) {
  if (token != T_STORE_GET) return;
  if (len >= 0) {
    settings_stored = 1;
    settings_read(p, (uint32_t)len);
  }
  loaded();
}

static void save(void) {
  char buf[2048];
  draft[S_BASE_DIR].len = 0;
  uint32_t n = cd_input_value(base_input, buf, sizeof buf);
  text_set(&draft[S_BASE_DIR], buf, n);
  n = cd_input_value(url_input, buf, sizeof buf);
  text_set(&draft[S_BRIDGE_URL], buf, n);
  n = cd_input_value(token_input, buf, sizeof buf);
  text_set(&draft[S_BRIDGE_TOKEN], buf, n);
  for (int f = 0; f < S_FIELDS; f++) text_set(&settings[f], draft[f].p, draft[f].len);
  settings_stored = 1;
  char *block = cd_alloc(settings_room(settings));
  uint32_t blen = settings_block(block, settings);
  cd_store_put(T_STORE_PUT, STORE_KEY, sizeof STORE_KEY - 1, block, blen);
  cd_free(block);
  saved_shown = 1;
  saved_view();
  cd_timer_start(2000, TIMER_SAVED);
  poll_status();
  refresh_decks();
}

void cd_on_event(const cd_event_rec *e) {
  if (e->type == CD_EV_VISIBILITY) {
    if (!e->key) poll_status(); /* key 1: hidden */
    return;
  }
  uint32_t tag = cd_tag((cd_id)e->id);
  if (tag == TAG_SETTINGS) {
    go("/settings", 9);
  } else if (tag == TAG_BACK) {
    cd_url_step(-1);
  } else if (tag == TAG_SCAN) {
    if (!scan_loading) scan();
  } else if (tag == TAG_SAVE) {
    save();
  } else if (tag >= TAG_PROFILE) {
    uint32_t i = tag - TAG_PROFILE;
    if (i < nprofiles) {
      text_set(&draft[S_COLLECTION], profiles[i].path.p, profiles[i].path.len);
      text_set(&draft[S_PROFILE], profiles[i].name.p, profiles[i].name.len);
    }
  } else if (tag >= TAG_DECK && tag < TAG_DECK + ndecks) {
    char path[32] = "/deck/";
    go(path, 6 + id_dec(path + 6, decks[tag - TAG_DECK].id));
  }
}

/* The shell: .App > .app-container > nav.navbar + .app-content, as AppShell and Navbar draw it. */
void cd_main(void) {
  cd_store_get(T_STORE_GET, STORE_KEY, sizeof STORE_KEY - 1, CD_STORE_DEADLINE_MS);
  char path[512];
  uint32_t len = cd_url_read(CD_URL_ALL, path, sizeof path);
  if (len > sizeof path || !parse_route(path, len)) {
    route = R_DECKS;
    cd_url_replace("/decks", 6);
  }
  cd_listen_window(CD_EV_VISIBILITY);
  app_content = cd_id_new();
  cd_at(CD_MOUNT, 0);
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("App"));
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("app-container"));
  cd_open(CD_LIT("nav"));
  cd_class(CD_LIT("navbar"));
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("navbar-brand"));
  cd_text(CD_LIT("AMGI"));
  cd_close();
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("navbar-actions"));
  badge_build(&badges[0]);
  cd_open(CD_LIT("button"));
  cd_class(CD_LIT("navbar-button action-btn settings-icon"));
  cd_attr(CD_LIT("title"), CD_LIT("Settings"));
  listen_click(TAG_SETTINGS);
  icon(COG, COG_HUB, 0);
  cd_close();
  cd_close();
  cd_close();
  cd_open(CD_LIT("div"));
  cd_class(CD_LIT("app-content"));
  cd_name_open(app_content);
  cd_close();
  cd_close();
  cd_close();
  page_show();
}
