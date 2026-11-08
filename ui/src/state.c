/* What DeckContext held: the transport's mode (polled every 4 s and when the tab shows again), the
 * decks, whether amgi is installed, the note types; and the mode badge that shows the first two. */
#include "app.h"

enum { T_STATUS = 1, T_DECKS, T_INSTALL, T_NOTETYPES };
enum { TIMER_POLL = 1 };
#define POLL_MS 4000

deck *decks;
uint32_t ndecks;
static uint32_t decks_cap;
int decks_known;
uint32_t mode = WIRE_MODE_UNCONFIGURED;
int installed = -1;
static int status_seen;
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

void refresh_decks(void) { ask(M_SHELL, T_DECKS, "GET", "/decks", WIRE_NONE, 0); }
void poll_status(void) { ask(M_SHELL, T_STATUS, "GET", "/status", WIRE_NONE, 0); }
void ensure_notetypes(void) {
  if (notetypes_asked) return;
  notetypes_asked = 1;
  ask(M_SHELL, T_NOTETYPES, "GET", "/notetypes", WIRE_NONE, 0);
}

void state_start(void) {
  poll_status();
  refresh_decks();
  cd_timer_start(POLL_MS, TIMER_POLL);
}
void state_timer(uint32_t token) {
  if (token != TIMER_POLL) return;
  poll_status();
  cd_timer_start(POLL_MS, TIMER_POLL);
}

static void set_mode(uint32_t m) {
  if (m == mode) return;
  mode = m;
  badges_update();
}

/* Closing Anki, or the bridge going up or down, changes the mode: what the mode implies is fetched
 * again, the decks and the open deck's notes. */
static void mode_changed(void) {
  refresh_decks();
  if (route == R_DECK) deck_reload();
}

static holder h_status, h_decks, h_install, h_notetypes;

void state_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  switch (token) {
  case T_STATUS: {
    wire_status s;
    answer a = take(&h_status, WK_STATUS, status, p, len, &s);
    if (!a.ok) return; /* the route always answers; no answer is the server not up */
    int changed = status_seen && s.mode != mode, first = !status_seen;
    status_seen = 1;
    set_mode(s.mode);
    if (changed && !first) mode_changed();
    break;
  }
  case T_DECKS: {
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
      ask(M_SHELL, T_INSTALL, "GET", "/install", WIRE_NONE, 0);
    } else {
      /* not reachable now (no profile, locked, bridge down): a mode the page explains */
      set_mode(a.err.mode != WIRE_MODE_OTHER && a.err.error.len ? a.err.mode : WIRE_MODE_UNCONFIGURED);
    }
    if (route == R_DECKS) {
      if (!was_known) page_show();
      else decks_rows();
    } else if (route == R_DECK) {
      if (!was_known) page_show();
      else deck_decks_changed();
    }
    break;
  }
  case T_INSTALL: {
    wire_install_state s;
    answer a = take(&h_install, WK_INSTALL_STATE, status, p, len, &s);
    int was = installed;
    installed = a.ok ? s.installed : 1; /* an answer that is not one counts as installed, as DeckContext's catch did */
    if (installed == was) return;
    badges_update();
    /* not installed is the setup screen: only a change across that redraws the screen */
    if (route == R_DECKS && (installed == 0) != (was == 0)) page_show();
    break;
  }
  case T_NOTETYPES: {
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
    break;
  }
  }
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
/* amgiNotetype.js's fieldIndexes: by name, case folded, never by position. The names asked for are
 * ASCII, so folding ASCII letters is the whole of toLowerCase's effect on a match. */
amgi_fields amgi_fields_of(const text *names, uint32_t n) {
  static const char *const NAMES[] = {"Cue", "CueAudio", "Target", "TargetAudio", "Language", "Notes"};
  int32_t at[6];
  for (int f = 0; f < 6; f++) {
    at[f] = -1;
    for (uint32_t i = 0; i < n && at[f] < 0; i++)
      if (same_ascii_nocase(names[i].p, names[i].len, NAMES[f])) at[f] = (int32_t)i;
  }
  return (amgi_fields){at[0], at[1], at[2], at[3], at[4], at[5]};
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
  attr_tmp(style, style_buf, dot_style(p->color));
  cd_close();
  cd_text(cd_internz(p->label));
  cd_name(b->label);
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
