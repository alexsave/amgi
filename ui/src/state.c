/* What DeckContext held: the transport's mode (polled every 4 s and when the tab shows again), the
 * decks, whether amgi is installed, the note types; and the mode badge that shows the first two. */
#include "app.h"

#define POLL_MS 4000

deck *decks;
uint32_t ndecks;
static uint32_t decks_cap;
int decks_known;
uint32_t mode = WIRE_MODE_UNCONFIGURED;
int installed = -1;
static int status_seen;
static int64_t open_next = -1;

void open_after_refresh(int64_t id) {
  open_next = id;
  refresh_decks();
}
notetype *notetypes;
uint32_t nnotetypes;
int notetypes_known;
static int notetypes_asked;

int ready(void) { return mode == WIRE_MODE_DIRECT || mode == WIRE_MODE_BRIDGE; }

const deck *deck_by_id(int64_t id) {
  for (uint32_t i = 0; i < ndecks; i++)
    if (decks[i].id == id) return &decks[i];
  return 0;
}

ON_ANSWER(status_answered);
ON_ANSWER(decks_answered);
ON_ANSWER(install_answered);
ON_ANSWER(notetypes_answered);

void refresh_decks(void) { ask(decks_answered, 0, "GET", "/decks", WIRE_NONE, 0); }

/* The list without a deck just deleted and the decks under it ("A" takes "A::B"), at once: the
 * list is drawn before the fresh answer comes, and must not show them in the meantime. */
void decks_drop_tree(int64_t id) {
  const deck *gone = deck_by_id(id);
  if (!gone) return;
  uint32_t glen;
  const char *g = cd_bytes(gone->name, &glen);
  char *prefix = cd_alloc(glen + 3);
  __builtin_memcpy(prefix, g, glen);
  __builtin_memcpy(prefix + glen, "::", 2);
  uint32_t kept = 0;
  for (uint32_t i = 0; i < ndecks; i++) {
    uint32_t n;
    const char *name = cd_bytes(decks[i].name, &n);
    if (decks[i].id == id || (n > glen + 2 && same(name, glen + 2, prefix, glen + 2))) continue;
    decks[kept++] = decks[i];
  }
  ndecks = kept;
  cd_free(prefix);
}
void poll_status(void) { ask(status_answered, 0, "GET", "/status", WIRE_NONE, 0); }
void ensure_notetypes(void) {
  if (notetypes_asked) return;
  notetypes_asked = 1;
  ask(notetypes_answered, 0, "GET", "/notetypes", WIRE_NONE, 0);
}

static void poll_again(void *ctx) {
  (void)ctx;
  poll_status();
  cd_timer_cb(POLL_MS, poll_again, 0);
}
void state_start(void) {
  template_mode_changed();
  poll_status();
  refresh_decks();
  cd_timer_cb(POLL_MS, poll_again, 0);
}

/* The decks screen follows the state: setup while amgi is not set up, the list once it is. */
static void decks_follow(void) {
  if (route == R_DECKS && decks_known && decks_setup_shown() != decks_setup_wanted()) page_show();
}

static void set_mode(uint32_t m) {
  if (m == mode) return;
  mode = m;
  badges_update();
  decks_follow();
  template_mode_changed(); /* whether Anki is open decides what the notice may do */
}

/* Closing Anki, or the bridge going up or down, changes the mode: what the mode implies is fetched
 * again, the decks and the open deck's notes. */
static void mode_changed(void) {
  refresh_decks();
  if (route == R_DECK) deck_reload();
}

static holder h_status, h_decks, h_install, h_notetypes;

ON_ANSWER(status_answered) {
  wire_status s;
  answer a = take(&h_status, WK_STATUS, status, p, len, &s);
  if (!a.ok) return; /* the route always answers; no answer is the server not up */
  int changed = status_seen && s.mode != mode, first = !status_seen;
  status_seen = 1;
  set_mode(s.mode);
  if (changed && !first) mode_changed();
}

ON_ANSWER(decks_answered) {
  wire_decks d;
  answer a = take(&h_decks, WK_DECKS, status, p, len, &d);
  int was_known = decks_known;
  decks_known = 1;
  if (a.ok) {
    if (d.ndecks > decks_cap) {
      decks_cap = d.ndecks;
      decks = cd_realloc(decks, decks_cap * sizeof *decks);
    }
    for (uint32_t i = 0; i < d.ndecks; i++)
      decks[i] = (deck){d.decks[i].id, cd_intern(d.decks[i].name.p, d.decks[i].name.len), d.decks[i].note_count};
    ndecks = d.ndecks;
    set_mode(d.mode);
    ask(install_answered, 0, "GET", "/install", WIRE_NONE, 0);
  } else {
    /* not reachable now (no profile, locked, bridge down): a mode the page explains */
    set_mode(a.err.mode != WIRE_MODE_OTHER && a.err.error.len ? a.err.mode : WIRE_MODE_UNCONFIGURED);
  }
  if (open_next >= 0 && deck_by_id(open_next)) {
    int64_t id = open_next;
    open_next = -1;
    go_deck(id);
  } else if (route == R_DECKS) {
    if (!was_known) page_show();
    else decks_rows();
  } else if (route == R_DECK) {
    if (!was_known) page_show();
    else deck_decks_changed();
  }
}

ON_ANSWER(install_answered) {
  wire_install_state s;
  answer a = take(&h_install, WK_INSTALL_STATE, status, p, len, &s);
  int was = installed;
  installed = a.ok ? s.installed : 1; /* an answer that is not one counts as installed, as DeckContext's catch did */
  if (installed == was) return;
  badges_update();
  decks_follow();
}

ON_ANSWER(notetypes_answered) {
  wire_notetypes n;
  answer a = take(&h_notetypes, WK_NOTETYPES, status, p, len, &n);
  if (!a.ok) {
    notetypes_asked = 0; /* asked again next time something needs them */
    return;
  }
  notetypes = cd_alloc((n.nnotetypes ? n.nnotetypes : 1) * sizeof *notetypes);
  for (uint32_t i = 0; i < n.nnotetypes; i++) {
    notetype *t = &notetypes[i];
    *t = (notetype){n.notetypes[i].id, {0, 0}, 0, n.notetypes[i].field_names.n, n.notetypes[i].sort_field_index};
    text_set(&t->name, n.notetypes[i].name.p, n.notetypes[i].name.len);
    t->fields = cd_alloc((t->nfields ? t->nfields : 1) * sizeof *t->fields);
    for (uint32_t k = 0; k < t->nfields; k++) {
      t->fields[k] = (text){0, 0};
      text_set(&t->fields[k], n.notetypes[i].field_names.v[k].p, n.notetypes[i].field_names.v[k].len);
    }
  }
  nnotetypes = n.nnotetypes;
  notetypes_known = 1;
  holder_free(&h_notetypes);
  if (route == R_DECK) deck_notetypes_known();
}

const notetype *notetype_by_id(int64_t id) {
  for (uint32_t i = 0; i < nnotetypes; i++)
    if (notetypes[i].id == id) return &notetypes[i];
  return 0;
}
const notetype *amgi_notetype(void) {
  for (uint32_t i = 0; i < nnotetypes; i++)
    if (same_z(notetypes[i].name.p, notetypes[i].name.len, AMGI_NOTETYPE_NAME)) return &notetypes[i];
  return 0;
}

/* ---- the mode badge: src/utils/ankiModeText.js's table ---- */
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
  [WIRE_MODE_BRIDGE_OUTDATED] = {"Anki: update amgi", "#e07050",
                                 "The amgi add-on running in Anki is from a different amgi than this one. Press "
                                 "Install into Anki again (Settings), then restart Anki."},
  [WIRE_MODE_DAMAGED] = {"Anki: damaged", "#e07050",
                         "The collection file is damaged; amgi did not open it. Anki can restore it from one of its backups."},
  [WIRE_MODE_OTHER] = {"Anki: not set up yet", "#808080", "amgi has not been installed into Anki on this machine yet."},
};
const presentation *present(uint32_t m) { return &PRESENT[m < WIRE_MODES ? m : WIRE_MODE_OTHER]; }
/* The badge cannot say "connected" over a page that says "set amgi up". */
static const presentation *badge_now(void) { return present(installed == 0 ? WIRE_MODE_UNCONFIGURED : mode); }

badge badges[2]; /* the navbar's, and Settings' "Current mode" */

static char style_buf[96];
static uint32_t dot_style(const char *color) {
  static const char A[] = "width: 7px; height: 7px; border-radius: 50%; background: ";
  static const char B[] = "; flex-shrink: 0;";
  uint32_t n = sizeof A - 1, c = zlen(color);
  __builtin_memcpy(style_buf, A, n);
  __builtin_memcpy(style_buf + n, color, c);
  n += c;
  __builtin_memcpy(style_buf + n, B, sizeof B - 1);
  return n + sizeof B - 1;
}

void badge_build(badge *b) {
  const presentation *p = badge_now();
  b->span = cd_open_id(CD_LIT("span"));
  cd_attr(CD_LIT("title"), cd_internz(p->title));
  cd_attr(CD_LIT("style"), CD_LIT("display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.7rem; "
                                  "font-weight: 600; letter-spacing: 0.02em; border: 1px solid var(--border-color); "
                                  "border-radius: 999px; padding: 0.2rem 0.6rem; color: var(--text-secondary); "
                                  "white-space: nowrap;"));
  b->dot = cd_open_id(CD_LIT("span"));
  cd_str style = CD_LIT("style");
  attr_tmp(style, style_buf, dot_style(p->color));
  cd_close();
  cd_text(cd_internz(p->label));
  cd_name(b->label = cd_id_new());
  cd_close();
}

void badges_update(void) {
  const presentation *p = badge_now();
  for (int i = 0; i < 2; i++) {
    badge *b = &badges[i];
    if (!b->span) continue;
    cd_set_attr(b->span, CD_LIT("title"), cd_internz(p->title));
    cd_str style = CD_LIT("style");
    cd_set_attr(b->dot, style, cd_tmp(style_buf, dot_style(p->color)));
    cd_set_text(b->label, cd_internz(p->label));
  }
}
