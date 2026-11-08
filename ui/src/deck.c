/* The deck screen (CardList, DeckName, DeckLanguages): the deck's header with its two languages, the
 * card form, and the notes a page at a time, each row with its clips. */
#include "app.h"

enum { T_NOTES = 1, T_DELETE, T_RENAME, T_DECK_SUMMARY, T_DECK_DELETE };
#define PAGE_SIZE 20

static int shown, langs_known, notes_loading, notes_known;
static int64_t deck_id = -1;
static lang_pair langs = {"en", "ko"};
static int langs_open;
static holder h_notes;
static wire_notes page_notes;     /* the page on screen; its strings live in h_notes */
/* What the rows on screen show, as a hash of the page (page_hash). A page that answers the same
 * again (the reload after a mode change: Anki opened or closed, the lock taken or let go) leaves
 * them as they are, so an open editor keeps its typing, its caret and its focus. 0: no rows. */
static uint64_t rows_hash;
static text notes_error;
static uint32_t want_offset;
static cd_id name_h1, title_box, sub_line, listhead_count, list_box, name_input;
static cd_region name_box = {0};  /* the h1's contents: the name's button, or its input while renaming */
static cd_region name_err = {0};  /* p.deck-name-error, under the h1 */
static int renaming, rename_saving, rename_cancelled;
static text rename_error;
static int64_t editing = -1, deleting = -1;
/* The open card's editor, opened and closed in place in its row: building the rows again would
 * leave the pointer over a new node the browser does not count as hovered until the mouse moves. */
static cd_region editor = {0};
static cd_id *row_li, *row_edit;   /* each row's li and its Edit button's text, by row */
static int32_t editor_row = -1;
static cd_region sub = {0};       /* the count and the languages: all the children of p.deck-cards-sub */
static cd_region body = {0};      /* div.empty-deck or ol.note-rows */
static cd_region pager = {0};
static cd_id known_select, learning_select;
static int32_t *row_chips;        /* the chips in the rows, forgotten with them */
static uint32_t nrow_chips;
/* Deleting the deck, last on the page: the section's contents, what it is doing, why it failed. */
static cd_region danger = {0};
enum { DANGER_IDLE, DANGER_CHECKING, DANGER_DELETING };
static int danger_state;
static text danger_error;

ON_EVENT(back) { go("/decks", 6); }
ON_EVENT(langs_open_pressed);
ON_EVENT(langs_done_pressed);
ON_EVENT(language_changed);
ON_EVENT(rename_pressed);
ON_EVENT(name_left);
ON_EVENT(name_key);
ON_EVENT(edit_pressed);
ON_EVENT(delete_pressed);
ON_EVENT(prev_pressed);
ON_EVENT(next_pressed);
ON_EVENT(deck_delete_pressed);

static const char *lang_label(const char *code) {
  const char *n = language_name(code, zlen(code));
  return n ? n : code;
}

static void ask_notes(uint32_t offset) {
  char path[96] = "/decks/";
  uint32_t n = 7 + id_dec(path + 7, deck_id);
  static const char Q1[] = "/notes?offset=", Q2[] = "&limit=";
  __builtin_memcpy(path + n, Q1, sizeof Q1 - 1);
  n += sizeof Q1 - 1;
  n += cd_fmt(path + n, (int32_t)offset, 0, CD_UNIT_NONE);
  __builtin_memcpy(path + n, Q2, sizeof Q2 - 1);
  n += sizeof Q2 - 1;
  n += cd_fmt(path + n, PAGE_SIZE, 0, CD_UNIT_NONE);
  path[n] = 0;
  want_offset = offset;
  notes_loading = 1;
  ask(M_DECK, T_NOTES, "GET", path, WIRE_NONE, 0);
}

void deck_reload(void) {
  if (shown && deck_id >= 0) ask_notes(notes_known ? page_notes.offset : 0);
}

/* The deck's own pair is loaded from the store before the screen is drawn (as localStorage was
 * read during React's render), so its labels are never drawn with the defaults first. */
void deck_langs_loaded(int64_t id, const lang_pair *p) {
  if (id != route_deck) return;
  langs = *p;
  deck_id = id;
  langs_known = 1;
  page_show();
}

static void sub_build(void) {
  cd_region_hide(&sub);
  const deck *d = deck_by_id(deck_id);
  if (!d || !cd_region_show(&sub, 1)) return;
  cd_at(sub_line, 0);
  cd_text_num(d->count);
  cd_text(CD_LIT(" card"));
  if (d->count != 1) cd_text(CD_LIT("s"));
  cd_text(CD_LIT(" · "));
  el(CD_LIT("span"), CD_LIT("deck-langs"));
  if (!langs_open) {
    const char *k = lang_label(langs.known), *l = lang_label(langs.learning);
    tmp_text(k, zlen(k));
    cd_text(CD_LIT(" → "));
    tmp_text(l, zlen(l));
    cd_id change = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_on(change, CD_EV_CLICK, langs_open_pressed, 0);
    cd_text(CD_LIT("Change"));
    cd_close();
  } else {
    for (int which = 0; which < 2; which++) {
      const char *cur = which ? langs.learning : langs.known;
      cd_id sel = cd_open_id(CD_LIT("select"));
      cd_attr(CD_LIT("aria-label"), which ? CD_LIT("Language you are learning") : CD_LIT("Language you already know"));
      cd_on(sel, CD_EV_CHANGE, language_changed, CTX_OF(which));
      if (which) learning_select = sel;
      else known_select = sel;
      for (uint32_t i = 0; i < NLANGUAGES; i++) {
        cd_open(CD_LIT("option"));
        cd_attr(CD_LIT("value"), cd_internz(LANGUAGES[i].code));
        if (same_z(cur, zlen(cur), LANGUAGES[i].code)) cd_attr(CD_LIT("selected"), CD_LIT(""));
        cd_text(cd_internz(LANGUAGES[i].name));
        cd_close();
      }
      cd_close();
      if (!which) {
        cd_open(CD_LIT("span"));
        cd_attr(CD_LIT("aria-hidden"), CD_LIT("true"));
        cd_text(CD_LIT("→"));
        cd_close();
      }
    }
    cd_id done = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_on(done, CD_EV_CLICK, langs_done_pressed, 0);
    cd_text(CD_LIT("Done"));
    cd_close();
  }
  cd_close();
  cd_region_end(&sub);
}

/* DeckName: the title, renamed where it is read. The button, or the input while renaming. */
static void name_view(void) {
  if (!shown || !name_box.parent) return;
  const deck *d = deck_by_id(deck_id);
  cd_region_hide(&name_box);
  if (!d || !cd_region_show(&name_box, 1)) return;
  cd_at(name_h1, 0);
  if (!renaming) {
    cd_id name_button = el_id(CD_LIT("button"), CD_LIT("deck-name-button"));
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_attr(CD_LIT("title"), CD_LIT("Rename this deck"));
    cd_on(name_button, CD_EV_CLICK, rename_pressed, 0);
    cd_text(rename_saving ? CD_LIT("Renaming…") : d->name);
    cd_close();
  } else {
    name_input = cd_open_id(CD_LIT("input"));
    cd_class(CD_LIT("deck-name-input"));
    cd_attr(CD_LIT("aria-label"), CD_LIT("Deck name"));
    uint32_t n;
    const char *name = cd_bytes(d->name, &n);
    cd_str value = CD_LIT("value");
    attr_tmp(value, name, n);
    cd_on(name_input, CD_EV_FOCUSOUT, name_left, 0);
    cd_on(name_input, CD_EV_KEYDOWN, name_key, 0);
    cd_close();
  }
  cd_region_end(&name_box);
  if (renaming) cd_call(name_input, CD_LIT("focus")); /* autoFocus */
  cd_region_hide(&name_err);
  if (!renaming && rename_error.len && cd_region_show(&name_err, 1)) {
    cd_at(title_box, sub_line);
    el(CD_LIT("p"), CD_LIT("deck-name-error"));
    cd_name_open(name_err.root);
    tmp_text(rename_error.p, rename_error.len);
    cd_close();
    cd_region_end(&name_err);
  }
}

static void rename_commit(void) {
  if (!renaming) return;
  const deck *d = deck_by_id(deck_id);
  char buf[512];
  wire_str typed = trim((wire_str){buf, cd_input_value(name_input, buf, sizeof buf)});
  renaming = 0;
  uint32_t n;
  const char *old = d ? cd_bytes(d->name, &n) : (n = 0, "");
  if (!d || rename_cancelled || !typed.len || same(typed.p, typed.len, old, n)) {
    rename_cancelled = 0;
    name_view();
    return;
  }
  rename_saving = 1;
  text_free(&rename_error);
  name_view();
  wire_q_deck_name q = {typed};
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(M_DECK, T_RENAME, "PATCH", path, WK_Q_DECK_NAME, &q);
}

void deck_build(void) {
  shown = 1;
  const deck *d = deck_by_id(route_deck);
  el(CD_LIT("div"), CD_LIT("deck-cards"));
  if (!langs_known || deck_id != route_deck) {
    /* the pair is on its way from the store (deck_langs_loaded draws the screen again) */
    langs_known = 0;
    deck_langs_load(route_deck);
    return;
  }
  el(CD_LIT("div"), CD_LIT("deck-cards-header"));
  title_box = el_id(CD_LIT("div"), CD_LIT("deck-cards-title"));
  name_h1 = cd_open_id(CD_LIT("h1"));
  name_box.parent = name_h1;
  cd_close();
  (void)d;
  sub_line = el_id(CD_LIT("p"), CD_LIT("deck-cards-sub"));
  sub.parent = sub_line;
  cd_close();
  cd_close();
  cd_on(el_id(CD_LIT("button"), CD_LIT("back-btn")), CD_EV_CLICK, back, 0);
  cd_text(CD_LIT("← Decks"));
  cd_close();
  cd_close();

  el(CD_LIT("div"), CD_LIT("deck-content"));
  form_build(deck_id, &langs);
  list_box = el_id(CD_LIT("div"), CD_LIT("deck-cards-list"));
  el(CD_LIT("div"), CD_LIT("deck-cards-listhead"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Cards in this deck"));
  cd_open(CD_LIT("span"));
  cd_text_num(d->count);
  cd_name(listhead_count = cd_id_new());
  cd_close();
  cd_close();
  cd_close();
  /* Not for the Default deck (id 1): Anki never removes it. Its remove_decks empties Default and
   * resets its name instead (rslib/src/decks/remove.rs), so "delete" would only empty it, and the
   * server refuses it on both transports. */
  if (deck_id != 1) {
    danger.parent = el_id(CD_LIT("section"), CD_LIT("deck-danger"));
    cd_attr(CD_LIT("aria-label"), CD_LIT("Delete this deck"));
    cd_close();
  }
  cd_close();
}

static void editor_close(void) {
  if (editor_row < 0) return;
  panel_forget();
  cd_region_hide(&editor);
  cd_set_class(row_li[editor_row], CD_LIT("note-row-wrap"));
  cd_set_text(row_edit[editor_row], CD_LIT("Edit"));
  editor_row = -1;
}

static void editor_open(uint32_t i) {
  const wire_note *n = &page_notes.notes[i];
  const notetype *t = notetype_by_id(n->notetype_id);
  if (!t || !row_edit[i] || !cd_region_show(&editor, 1)) return;
  editor_row = (int32_t)i;
  cd_set_class(row_li[i], CD_LIT("note-row-wrap is-open"));
  cd_set_text(row_edit[i], CD_LIT("Close"));
  cd_at(row_li[i], 0);
  el(CD_LIT("div"), CD_LIT("note-row-editor"));
  cd_name_open(editor.root);
  panel_build(n->id, &n->fields, t->fields, t->nfields, &langs);
  cd_close();
  cd_region_end(&editor);
  panel_after();
}

static void rows_forget(void) {
  rows_hash = 0;
  if (editor_row >= 0) {
    panel_forget();
    cd_region_hide(&editor);
    editor_row = -1;
  }
  for (uint32_t i = 0; i < nrow_chips; i++) chip_forget(row_chips[i]);
  nrow_chips = 0;
  cd_region_hide(&body);
  cd_region_hide(&pager);
}

void deck_forget(void) {
  if (!shown) return;
  shown = 0;
  rows_forget();
  cd_region_hide(&sub);
  sub.parent = 0;
  cd_region_hide(&name_err);
  cd_region_hide(&name_box);
  name_box.parent = 0;
  renaming = rename_saving = 0;
  text_free(&rename_error);
  form_forget();
  cd_region_hide(&danger);
  danger.parent = 0;
  danger_state = DANGER_IDLE;
  text_free(&danger_error);
  langs_open = 0;
  if (route != R_DECK || route_deck != deck_id) {
    editing = deleting = -1;
    langs_known = 0;
    notes_known = 0;
    holder_free(&h_notes);
  }
}

static void keep_chip(int32_t slot) {
  if (slot < 0) return;
  row_chips = cd_realloc(row_chips, (nrow_chips + 1) * sizeof *row_chips);
  row_chips[nrow_chips++] = slot;
}

/* A field's text by name (CardList's textIn): the tags taken out, trimmed. */
static wire_str field_named(const wire_note *n, const notetype *t, const char *name) {
  if (!t) return (wire_str){"", 0};
  for (uint32_t i = 0; i < t->nfields && i < n->fields.n; i++)
    if (same_ascii_nocase(t->fields[i].p, t->fields[i].len, name)) return n->fields.v[i];
  return (wire_str){"", 0};
}

static void row_build(uint32_t i) {
  const wire_note *n = &page_notes.notes[i];
  const notetype *t = notetype_by_id(n->notetype_id);
  int amgi = t && same_z(t->name.p, t->name.len, AMGI_NOTETYPE_NAME);
  /* DeckContext's mapAnkiNoteToCard: the prompt is the guessed text field (the first field when the
   * note type is unknown), the audio the guessed audio field */
  field_guess g = {0, -1, -1};
  if (t) g = guess_fields(t->fields, t->nfields, t->sort_field);
  wire_str prompt = g.text >= 0 && (uint32_t)g.text < n->fields.n ? n->fields.v[g.text]
                    : n->fields.n                                ? n->fields.v[0]
                                                                 : (wire_str){"", 0};
  int has_audio = g.audio >= 0 && (uint32_t)g.audio < n->fields.n && has_audio_ref(n->fields.v[g.audio]);
  char *front = cd_alloc(prompt.len + 1);
  uint32_t flen = strip_html(front, prompt);

  int open = 0; /* the editor opens after the rows are built: editor_open */
  row_li[i] = el_id(CD_LIT("li"), CD_LIT("note-row-wrap"));
  row_edit[i] = 0;
  el(CD_LIT("div"), CD_LIT("note-row"));
  el(CD_LIT("span"), CD_LIT("note-row-target"));
  tmp_text(front, flen);
  cd_close();
  el(CD_LIT("span"), CD_LIT("note-row-cue"));
  if (amgi) {
    wire_str cue = field_named(n, t, "Cue");
    char *c = cd_alloc(cue.len + 1);
    tmp_text(c, strip_tags(c, cue));
    cd_free(c);
  } else {
    el(CD_LIT("span"), CD_LIT("note-row-type"));
    if (t) {
      tmp_text(t->name.p, t->name.len);
    } else {
      char nm[40] = "Note type ";
      tmp_text(nm, 10 + id_dec(nm + 10, n->notetype_id));
    }
    cd_close();
    cd_text(CD_LIT(" not an amgi card"));
  }
  cd_close();
  el(CD_LIT("span"), CD_LIT("note-row-clips"));
  wire_str cue_clip = audio_src(field_named(n, t, "CueAudio")), target_clip = audio_src(field_named(n, t, "TargetAudio"));
  keep_chip(chip_build(cue_clip.p, cue_clip.len, lang_label(langs.known), TONE_CUE));
  keep_chip(chip_build(target_clip.p, target_clip.len, lang_label(langs.learning), TONE_TARGET));
  if (amgi && !has_audio) el_text(CD_LIT("small"), CD_LIT("note-row-noaudio"), CD_LIT("no audio yet"));
  cd_close();
  if (amgi) {
    cd_id edit = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("note-row-edit"));
    cd_on(edit, CD_EV_CLICK, edit_pressed, CTX_OF(i));
    cd_text(open ? CD_LIT("Close") : CD_LIT("Edit"));
    cd_name(row_edit[i] = cd_id_new());
    cd_close();
  } else {
    el(CD_LIT("span"), CD_LIT("note-row-edit note-row-edit-off"));
    cd_attr(CD_LIT("title"), CD_LIT("amgi only edits its own note type"));
    cd_text(CD_LIT("—"));
    cd_close();
  }
  cd_id del = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("note-row-delete"));
  cd_attr(CD_LIT("title"), CD_LIT("Delete this card"));
  {
    static const char D[] = "Delete ";
    char *label = cd_alloc(sizeof D + flen);
    __builtin_memcpy(label, D, sizeof D - 1);
    __builtin_memcpy(label + sizeof D - 1, front, flen);
    cd_str aria = CD_LIT("aria-label");
    attr_tmp(aria, label, (uint32_t)sizeof D - 1 + flen);
    cd_free(label);
  }
  cd_on(del, CD_EV_CLICK, delete_pressed, CTX_OF(i));
  if (deleting == n->id) {
    cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_text(CD_LIT("…"));
  } else {
    icon(ICON_TRASH, 0, 0);
  }
  cd_close();
  cd_close(); /* .note-row */
  cd_close();
  cd_free(front);
}

/* FNV-1a over everything the rows draw from: the page's place, each note's id, type, fields and
 * tags, and the page's own state a row shows. */
static uint64_t mix(uint64_t h, const void *p, uint32_t n) {
  const uint8_t *b = p;
  for (uint32_t i = 0; i < n; i++) h = (h ^ b[i]) * 0x100000001b3ull;
  return h;
}
static uint64_t mix_strs(uint64_t h, const wire_strs *v) {
  h = mix(h, &v->n, sizeof v->n);
  for (uint32_t i = 0; i < v->n; i++) {
    h = mix(h, &v->v[i].len, sizeof v->v[i].len);
    h = mix(h, v->v[i].p, v->v[i].len);
  }
  return h;
}
static uint64_t page_hash(void) {
  uint64_t h = 0xcbf29ce484222325ull;
  /* what else a row shows: the card being deleted, and the languages its chips are labelled with */
  h = mix(h, &deleting, sizeof deleting);
  h = mix(h, &langs, sizeof langs);
  h = mix(h, &page_notes.offset, sizeof page_notes.offset);
  h = mix(h, &page_notes.has_more, sizeof page_notes.has_more);
  for (uint32_t i = 0; i < page_notes.nnotes; i++) {
    const wire_note *n = &page_notes.notes[i];
    h = mix(h, &n->id, sizeof n->id);
    h = mix(h, &n->notetype_id, sizeof n->notetype_id);
    h = mix_strs(h, &n->fields);
    h = mix_strs(h, &n->tags);
  }
  return h | 1; /* never 0, which means no rows */
}

static void rows_build(void) {
  if (!shown || !list_box) return;
  rows_forget();
  if (!cd_region_show(&body, 1)) return;
  cd_at(list_box, 0);
  if (notes_error.len) {
    el(CD_LIT("div"), CD_LIT("empty-deck"));
    cd_name_open(body.root);
    cd_open(CD_LIT("p"));
    cd_text(CD_LIT("Could not load this deck's notes: "));
    tmp_text(notes_error.p, notes_error.len);
    cd_close();
    cd_close();
  } else if (!notes_known || !notetypes_known || !page_notes.nnotes) {
    el(CD_LIT("div"), CD_LIT("empty-deck"));
    cd_name_open(body.root);
    cd_open(CD_LIT("p"));
    cd_text(notes_known && notetypes_known && !notes_loading ? CD_LIT("No notes in this deck yet.") : CD_LIT("Loading notes…"));
    cd_close();
    cd_close();
  } else {
    el(CD_LIT("ol"), CD_LIT("note-rows"));
    cd_name_open(body.root);
    row_li = cd_realloc(row_li, (page_notes.nnotes + 1) * sizeof *row_li);
    row_edit = cd_realloc(row_edit, (page_notes.nnotes + 1) * sizeof *row_edit);
    for (uint32_t i = 0; i < page_notes.nnotes; i++) row_build(i);
    cd_close();
    rows_hash = page_hash();
  }
  cd_region_end(&body);
  for (uint32_t i = 0; editing >= 0 && notes_known && i < page_notes.nnotes; i++)
    if (page_notes.notes[i].id == editing) editor_open(i);

  uint32_t n = notes_known && notetypes_known ? page_notes.nnotes : 0;
  if (!n || (!page_notes.offset && !page_notes.has_more) || !cd_region_show(&pager, 1)) return;
  cd_at(list_box, 0);
  el(CD_LIT("div"), CD_LIT("card-list-pager"));
  cd_name_open(pager.root);
  cd_attr(CD_LIT("style"), CD_LIT("display: flex; justify-content: center; gap: 1rem; align-items: center; margin-top: 1rem;"));
  for (int which = 0; which < 2; which++) {
    if (which) {
      cd_open(CD_LIT("small"));
      cd_attr(CD_LIT("style"), CD_LIT("opacity: 0.75;"));
      cd_text_num(page_notes.offset + 1);
      cd_text(CD_LIT("–"));
      cd_text_num(page_notes.offset + n);
      cd_close();
    }
    cd_id step = el_id(CD_LIT("button"), CD_LIT("back-btn"));
    int off = which ? !page_notes.has_more || notes_loading : !page_notes.offset || notes_loading;
    if (off) cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_on(step, CD_EV_CLICK, which ? next_pressed : prev_pressed, 0);
    cd_text(which ? CD_LIT("Next →") : CD_LIT("← Prev"));
    cd_close();
  }
  cd_close();
  cd_region_end(&pager);
}

/* The danger section's contents: what deleting means, the button (what it is doing, while it is),
 * and why the last try failed. */
static void danger_view(void) {
  cd_region_hide(&danger);
  if (!shown || !danger.parent || !cd_region_show(&danger, 1)) return;
  cd_at(danger.parent, 0);
  el(CD_LIT("div"), CD_LIT("deck-danger-text"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Delete this deck"));
  el_text(CD_LIT("p"), 0, CD_LIT("The deck, its subdecks and every card in them, on every device you sync with."));
  cd_close();
  cd_id del = el_id(CD_LIT("button"), CD_LIT("deck-danger-btn"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  if (danger_state != DANGER_IDLE) cd_attr(CD_LIT("disabled"), CD_LIT(""));
  cd_on(del, CD_EV_CLICK, deck_delete_pressed, 0);
  cd_text(danger_state == DANGER_CHECKING   ? CD_LIT("Checking…")
          : danger_state == DANGER_DELETING ? CD_LIT("Deleting…")
                                            : CD_LIT("Delete deck"));
  cd_close();
  if (danger_error.len) {
    el(CD_LIT("p"), CD_LIT("deck-danger-error"));
    cd_attr(CD_LIT("role"), CD_LIT("alert"));
    tmp_text(danger_error.p, danger_error.len);
    cd_close();
  }
  cd_region_end(&danger);
}

void deck_after(void) {
  if (!langs_known) return;
  name_view();
  sub_build();
  danger_view();
  ensure_notetypes();
  if (!notes_known || page_notes.offset != want_offset) ask_notes(0);
  rows_build();
  form_notetypes_known();
}

void deck_decks_changed(void) {
  if (!shown || !langs_known) return;
  const deck *d = deck_by_id(deck_id);
  if (!d) {
    page_show(); /* the deck went: back to the list */
    return;
  }
  if (!renaming) name_view(); /* an open rename keeps what is typed in it; it shows the name again when it closes */
  cd_set_text_num(listhead_count, d->count);
  sub_build();
}

static holder h_write;
static int64_t pending_delete = -1;
static void delete_now(void *ctx) {
  (void)ctx;
  deleting = pending_delete;
  rows_build(); /* the row's button says … while it goes */
  char path[48] = "/notes/";
  path[7 + id_dec(path + 7, deleting)] = 0;
  ask(M_DECK, T_DELETE, "DELETE", path, WIRE_NONE, 0);
}

/* A note went (its row's delete, or its panel's): its editor closes, the page and the counts follow. */
void deck_note_removed(int64_t id) {
  if (editing == id) editing = -1;
  deleting = -1;
  ask_notes(page_notes.offset);
  refresh_decks();
}

/* ---- deleting the deck ---- */
typedef struct { char *p; uint32_t len, cap; } line;
static void put(line *l, const char *p, uint32_t n) {
  if (l->len + n + 1 > l->cap) {
    l->cap = (l->len + n + 1) * 2;
    l->p = cd_realloc(l->p, l->cap);
  }
  __builtin_memcpy(l->p + l->len, p, n);
  l->len += n;
  l->p[l->len] = 0;
}
static void putz(line *l, const char *z) { put(l, z, zlen(z)); }
static void put_count(line *l, uint32_t n, const char *one, const char *many) {
  char d[12];
  put(l, d, cd_fmt(d, (int32_t)n, 0, CD_UNIT_NONE));
  putz(l, n == 1 ? one : many);
}

static void deck_delete_now(void *ctx) {
  (void)ctx;
  danger_state = DANGER_DELETING;
  text_free(&danger_error);
  danger_view();
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(M_DECK, T_DECK_DELETE, "DELETE", path, WIRE_NONE, 0);
}

/* The confirmation names the deck and says what goes with it, from the server's own count of what
 * Anki's remove takes: its subdecks, the cards in them (and cards of theirs a filtered deck had
 * borrowed), the notes left with no card. */
static void deck_delete_ask(const wire_deck_summary *s) {
  line title = {0, 0, 0}, body = {0, 0, 0};
  putz(&title, "Delete “");
  put(&title, s->name.p, s->name.len);
  putz(&title, "”?");
  putz(&body, "This deletes “");
  put(&body, s->name.p, s->name.len);
  putz(&body, "”");
  if (s->subdecks == 1) putz(&body, " and its subdeck");
  else if (s->subdecks) {
    putz(&body, " and its ");
    put_count(&body, s->subdecks, " subdeck", " subdecks");
  }
  if (!s->cards) {
    putz(&body, s->subdecks ? ". There are no cards in them." : ". There are no cards in it.");
  } else {
    /* "with 1 card in it and the note it belongs to", "with the 6 cards in them and the 4 notes
     * they belong to" */
    putz(&body, ", with ");
    if (s->cards == 1) putz(&body, "1 card");
    else {
      putz(&body, "the ");
      put_count(&body, s->cards, " card", " cards");
    }
    putz(&body, s->subdecks ? " in them" : " in it");
    if (s->notes) {
      putz(&body, " and the ");
      if (s->notes > 1) put_count(&body, s->notes, " note", " notes");
      else putz(&body, "note");
      putz(&body, s->cards == 1 ? " it belongs to" : " they belong to");
    }
    putz(&body, ".");
  }
  confirm_ask(title.p, body.p, body.len,
              s->cards ? "Their review history goes too, on every device you sync with." : "It goes on every device you sync with.",
              "Delete", deck_delete_now, 0);
  cd_free(title.p);
  cd_free(body.p);
}

void deck_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (token == T_DECK_DELETE) {
    /* answered even when the page went meanwhile: the deck list must not keep a deck that went */
    wire_deck_removed r;
    answer a = take(&h_write, WK_DECK_REMOVED, status, p, len, &r);
    int here = shown && route == R_DECK && route_deck == deck_id;
    danger_state = DANGER_IDLE;
    if (a.ok) {
      decks_drop_tree(r.id);
      refresh_decks();
      /* replace, not push: Back must not come back to a deck that is gone */
      if (here) go_replace("/decks", 6);
    } else if (a.status == 404) {
      refresh_decks(); /* gone already: the page becomes "this deck no longer exists" */
    } else if (here) {
      char m[600];
      text_set(&danger_error, m, answer_message(&a, m, sizeof m));
      danger_view();
    }
    return;
  }
  if (!shown) return;
  if (token == T_DECK_SUMMARY) {
    wire_deck_summary s;
    answer a = take(&h_write, WK_DECK_SUMMARY, status, p, len, &s);
    danger_state = DANGER_IDLE;
    if (a.ok) {
      danger_view();
      deck_delete_ask(&s);
    } else if (a.status == 404) {
      refresh_decks();
    } else {
      char m[600];
      text_set(&danger_error, m, answer_message(&a, m, sizeof m));
      danger_view();
    }
    return;
  }
  if (token == T_DELETE) {
    wire_note_changed c;
    answer a = take(&h_write, WK_NOTE_CHANGED, status, p, len, &c);
    int64_t id = deleting;
    if (a.ok) {
      deck_note_removed(id);
    } else {
      /* window.alert(err.message) in React: here the same dialog, with OK alone */
      char m[600];
      uint32_t n = answer_message(&a, m, sizeof m);
      deleting = -1;
      rows_build();
      confirm_ask("Could not delete the card", m, n, 0, "OK", 0, 0);
    }
    return;
  }
  if (token == T_RENAME) {
    wire_deck_renamed r;
    answer a = take(&h_write, WK_DECK_RENAMED, status, p, len, &r);
    rename_saving = 0;
    if (!a.ok) {
      /* Anki refuses a name another deck has, and so do we: say which, keep the old name */
      char m[600];
      text_set(&rename_error, m, answer_message(&a, m, sizeof m));
    }
    name_view();
    refresh_decks();
    return;
  }
  if (token != T_NOTES) return;
  /* Read into a page of its own first: the one on screen stays whole until this one replaces it. */
  static holder h_next;
  wire_notes next = {0};
  answer a = take(&h_next, WK_NOTES, status, p, len, &next);
  notes_loading = 0;
  if (!a.ok && rows_hash && want_offset == page_notes.offset) {
    /* The same page asked for again, and not answered: Anki took the file (the badge says so) or the
     * bridge went. The rows on screen are still what the deck holds; keep them, and an open editor. */
    holder_free(&h_next);
    return;
  }
  holder_free(&h_notes);
  h_notes = h_next;
  h_next = (holder){0};
  page_notes = next;
  if (a.ok) {
    notes_known = 1;
    text_free(&notes_error);
    if (rows_hash && notetypes_known && page_hash() == rows_hash) return; /* the same rows: keep them */
  } else {
    char m[512];
    text_set(&notes_error, m, answer_message(&a, m, sizeof m));
    page_notes.nnotes = 0;
  }
  rows_build();
}

/* Called when the note types arrive (state.c): the rows can name their types now. */
void deck_notetypes_known(void) {
  if (!shown || !langs_known) return;
  form_notetypes_known();
  if (notes_known) rows_build();
}

ON_EVENT(prev_pressed) {
  if (page_notes.offset && !notes_loading) ask_notes(page_notes.offset > PAGE_SIZE ? page_notes.offset - PAGE_SIZE : 0);
}
ON_EVENT(next_pressed) {
  if (page_notes.has_more && !notes_loading) ask_notes(page_notes.offset + PAGE_SIZE);
}
ON_EVENT(edit_pressed) {
  uint32_t i = CTX_INDEX(ctx);
  if (i >= page_notes.nnotes) return;
  int64_t id = page_notes.notes[i].id;
  int was = editing == id;
  editor_close();
  editing = was ? -1 : id;
  if (!was) editor_open(i);
}
ON_EVENT(delete_pressed) {
  uint32_t i = CTX_INDEX(ctx);
  if (i >= page_notes.nnotes || deleting >= 0) return;
  const wire_note *n = &page_notes.notes[i];
  const notetype *t = notetype_by_id(n->notetype_id);
  field_guess g = {0, -1, -1};
  if (t) g = guess_fields(t->fields, t->nfields, t->sort_field);
  wire_str prompt = g.text >= 0 && (uint32_t)g.text < n->fields.n ? n->fields.v[g.text]
                    : n->fields.n                                ? n->fields.v[0]
                                                                 : (wire_str){"", 0};
  char *front = cd_alloc(prompt.len + 1);
  uint32_t flen = strip_html(front, prompt);
  deleting = n->id;
  /* the confirmation names the card: the row is small and the thing destroyed is not */
  confirm_ask("Delete this card?", front, flen, "Its review history goes too, on every device you sync with.", "Delete",
              delete_now, 0);
  cd_free(front);
  deleting = -1; /* set again when the answer is yes (delete_now) */
  pending_delete = n->id;
}
ON_EVENT(deck_delete_pressed) {
  if (danger_state != DANGER_IDLE) return;
  /* first what it would take, so the confirmation can say it exactly */
  danger_state = DANGER_CHECKING;
  text_free(&danger_error);
  danger_view();
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(M_DECK, T_DECK_SUMMARY, "GET", path, WIRE_NONE, 0);
}
ON_EVENT(rename_pressed) {
  renaming = 1;
  rename_cancelled = 0;
  name_view();
}
ON_EVENT(name_left) { rename_commit(); }
ON_EVENT(name_key) {
  if (e->key == 13) cd_call(name_input, CD_LIT("blur")); /* Enter: leaving the field saves */
  if (e->key == 27) {                                   /* Escape abandons the edit */
    rename_cancelled = 1;
    renaming = 0;
    name_view();
  }
}
ON_EVENT(langs_open_pressed) {
  langs_open = 1;
  sub_build();
}
ON_EVENT(langs_done_pressed) {
  langs_open = 0;
  sub_build();
}
/* ctx: 0 the language known, 1 the one learnt */
ON_EVENT(language_changed) {
  char code[8];
  int learning = CTX_INDEX(ctx) == 1;
  uint32_t n = cd_input_value(learning ? learning_select : known_select, code, sizeof code - 1);
  if (!language_name(code, n)) return;
  code[n] = 0;
  __builtin_memcpy(learning ? langs.learning : langs.known, code, n + 1);
  deck_langs_save(deck_id, &langs);
  form_langs_changed(&langs);
  rows_build(); /* the chips carry the language names */
}

/* A deck page for a deck that is not in the list while the collection answers: deleted here, in
 * Anki, or on another device and synced. Said, with the way back, rather than an empty page or a
 * silent jump. Built as deck_build is, under page.root (div.deck-cards left open). */
void deck_gone_build(void) {
  el(CD_LIT("div"), CD_LIT("deck-cards"));
  el(CD_LIT("div"), CD_LIT("deck-gone"));
  el_text(CD_LIT("h1"), 0, CD_LIT("This deck no longer exists"));
  el_text(CD_LIT("p"), 0, CD_LIT("It was deleted, here, in Anki, or on another device you sync with."));
  cd_id back_button = el_id(CD_LIT("button"), CD_LIT("back-btn"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_on(back_button, CD_EV_CLICK, back, 0);
  cd_text(CD_LIT("← Decks"));
  cd_close();
  cd_close();
}
