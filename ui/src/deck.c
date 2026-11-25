/* The deck screen (CardList, DeckName, DeckLanguages): the deck's header with its two languages, the
 * card form, and the notes a page at a time, each row with its clips. */
#include "app.h"

#define PAGE_SIZE 20

static int shown, notes_loading, notes_known;
static int64_t deck_id = -1;
/* The deck's pair ("" known: none yet). finding: the server is working it out (asked once a visit, detect_deck).
 * The picker is open with a pair stored (Change, langs_open) or with none (the guess, or nothing, in pick). */
static lang_pair langs, pick;
static int langs_open, finding, langs_saving;
static int64_t detect_deck = -1;
static uint32_t langs_ask; /* the last languages request this page made: an answer to an older one, or one for a deck left, is dropped */
static text langs_error;
static holder h_notes;
static wire_notes page_notes;     /* the page on screen; its strings live in h_notes */
/* What the rows on screen show, as a hash of the page (page_hash). A page that answers the same
 * again (the reload after a mode change: Anki opened or closed, the lock taken or let go) leaves
 * them as they are, so an open editor keeps its typing, its caret and its focus. 0: no rows. */
static uint64_t rows_hash;
static text notes_error;
static uint32_t want_offset;
static cd_id name_h1, title_box, sub_line, listhead_count, list_box, name_input;
static cd_region name_box = {.up = &page_region};  /* the h1's contents: the name's button, or its input while renaming */
static cd_region name_err = {.up = &page_region};  /* p.deck-name-error, under the h1 */
static int renaming, rename_saving, rename_cancelled;
static text rename_error;
static int64_t editing = -1, deleting = -1;
/* The open card's editor, opened and closed in place in its row: building the rows again would
 * leave the pointer over a new node the browser does not count as hovered until the mouse moves. */
static cd_id *row_li, *row_edit;   /* each row's li and its Edit button's text, by row */
static int32_t editor_row = -1;
static cd_region sub = {.up = &page_region};       /* the count and the languages: all the children of p.deck-cards-sub */
static cd_region langs_err = {.up = &page_region}; /* p.deck-name-error, after the line: shown while langs_error is set */
static cd_region body = {.up = &page_region};      /* div.empty-deck or ol.note-rows */
static cd_region pager = {.up = &page_region};
static cd_bound prev_off, next_off, range_lo, range_hi;
static cd_region editor = {.up = &body}; /* in a row of the body */
static cd_id known_select, learning_select, save_button;
/* Deleting the deck, last on the page: the section's contents, what it is doing, why it failed. */
static cd_region danger = {.up = &page_region};
static cd_region danger_err = {.up = &danger}; /* p.deck-danger-error, after the button: shown while danger_error is set */
static cd_bound danger_label, danger_off;      /* the button's words and its disabled state */
enum { DANGER_IDLE, DANGER_CHECKING, DANGER_DELETING };
static int danger_state;
static text danger_error;

static void dirty(cd_render_fn view) {
  if (shown) cd_dirty(view, 0);
}
ON_RENDER(name_view);
ON_RENDER(sub_view);
ON_RENDER(rows_view);
ON_RENDER(danger_view);
ON_RENDER(pager_view);

ON_EVENT(back) { go("/decks", 6); }
ON_ANSWER(notes_answered);
ON_ANSWER(renamed);
ON_ANSWER(note_deleted);
ON_ANSWER(summary_answered);
ON_ANSWER(deck_removed);
ON_ANSWER(languages_found);
ON_ANSWER(languages_saved);
ON_EVENT(langs_open_pressed);
ON_EVENT(langs_save_pressed);
ON_EVENT(langs_cancel_pressed);
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
  ask(notes_answered, 0, "GET", path, WIRE_NONE, 0);
}

void deck_reload(void) {
  if (shown && deck_id >= 0) ask_notes(notes_known ? page_notes.offset : 0);
}

/* The picker's Save: both chosen (the two can never be the same code: language_changed refuses it), and no save under way. */
static void pick_sync(void) {
  cd_set_bool(known_select, "disabled", langs_saving);
  cd_set_bool(learning_select, "disabled", langs_saving);
  cd_set_bool(save_button, "disabled", langs_saving || !lang_pair_ok(pick.known, zlen(pick.known), pick.learning, zlen(pick.learning)));
}

/* The pair, or the lack of one, changed: the form and the rows' chips follow. */
static void langs_apply(void) {
  form_langs_changed(&langs, finding);
  dirty(rows_view);
  dirty(sub_view);
}

static void deck_path(char *path, const char *tail, uint32_t tlen) {
  __builtin_memcpy(path, "/decks/", 7);
  uint32_t n = 7 + id_dec(path + 7, deck_id);
  __builtin_memcpy(path + n, tail, tlen);
  path[n + tlen] = 0;
}

ON_RENDER(sub_view) {
  cd_region_hide(&sub);
  cd_region_hide(&langs_err);
  const deck *d = deck_by_id(deck_id);
  if (!d || !cd_region_show(&sub, 1)) return;
  cd_at(sub_line, 0);
  cd_text_num(d->count);
  cd_text(" card");
  if (d->count != 1) cd_text("s");
  /* the separator only before text on the same line: the picker's controls wrap under the count on a phone, and a dot
   * left at the end of the count's line separates nothing */
  int picking = !finding && (langs_open || !langs.known[0]);
  if (!picking) cd_text(" · ");
  el("span", "deck-langs");
  if (finding) {
    cd_text("Finding this deck's languages…");
  } else if (!langs_open && langs.known[0]) {
    const char *k = lang_label(langs.known), *l = lang_label(langs.learning);
    tmp_text(k, zlen(k));
    cd_text(" → ");
    tmp_text(l, zlen(l));
    cd_id change = el_id("button", 0);
    cd_attr("type", "button");
    cd_on(change, CD_EV_CLICK, langs_open_pressed, 0);
    cd_text("Change");
    cd_close();
  } else {
    for (int which = 0; which < 2; which++) {
      const char *cur = which ? pick.learning : pick.known;
      cd_id sel = cd_open_id("select");
      cd_attr("aria-label", which ? "Language you are learning" : "Language you already know");
      cd_on(sel, CD_EV_CHANGE, language_changed, CTX_OF(which));
      if (which) learning_select = sel;
      else known_select = sel;
      if (!cur[0]) {
        cd_open("option");
        cd_attr("value", "");
        cd_attr("disabled", "");
        cd_attr("selected", "");
        cd_text("Choose…");
        cd_close();
      }
      for (uint32_t i = 0; i < NLANGUAGES; i++) {
        cd_open("option");
        cd_attr("value", LANGUAGES[i].code);
        if (same_z(cur, zlen(cur), LANGUAGES[i].code)) cd_attr("selected", "");
        cd_text(LANGUAGES[i].name);
        cd_close();
      }
      cd_close();
      if (!which) {
        cd_open("span");
        cd_attr("aria-hidden", "true");
        cd_text("→");
        cd_close();
      }
    }
    save_button = el_id("button", 0);
    cd_attr("type", "button");
    cd_on(save_button, CD_EV_CLICK, langs_save_pressed, 0);
    cd_text("Save");
    cd_close();
    if (langs.known[0]) {
      cd_on(el_id("button", 0), CD_EV_CLICK, langs_cancel_pressed, 0);
      cd_attr("type", "button");
      cd_text("Cancel");
      cd_close();
    }
    pick_sync();
  }
  cd_close();
  cd_region_end(&sub);
  if (langs_error.len && cd_region_show(&langs_err, 1)) {
    cd_at(title_box, 0);
    el("p", "deck-name-error");
    cd_name_open(langs_err.root);
    cd_attr("role", "alert");
    tmp_text(langs_error.p, langs_error.len);
    cd_close();
    cd_region_end(&langs_err);
  }
}

/* DeckName: the title, renamed where it is read. The button, or the input while renaming. */
ON_RENDER(name_view) {
  const deck *d = deck_by_id(deck_id);
  cd_region_hide(&name_box);
  if (!d || !cd_region_show(&name_box, 1)) return;
  cd_at(name_h1, 0);
  if (!renaming) {
    cd_id name_button = el_id("button", "deck-name-button");
    cd_attr("type", "button");
    cd_attr("title", "Rename this deck");
    cd_on(name_button, CD_EV_CLICK, rename_pressed, 0);
    if (rename_saving) cd_text("Renaming…");
    else tmp_text(d->name.p, d->name.len);
    cd_close();
  } else {
    name_input = cd_open_id("input");
    cd_class("deck-name-input");
    cd_attr("aria-label", "Deck name");
    attr_tmp("value", d->name.p, d->name.len);
    cd_on(name_input, CD_EV_FOCUSOUT, name_left, 0);
    cd_on(name_input, CD_EV_KEYDOWN, name_key, 0);
    cd_close();
  }
  cd_region_end(&name_box);
  if (renaming) cd_call(name_input, "focus"); /* autoFocus */
  cd_region_hide(&name_err);
  if (!renaming && rename_error.len && cd_region_show(&name_err, 1)) {
    cd_at(title_box, sub_line);
    el("p", "deck-name-error");
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
  uint32_t len;
  int fits = cd_input_whole(name_input, buf, sizeof buf, &len);
  wire_str typed = trim((wire_str){buf, fits ? len : 0});
  renaming = 0;
  if (d && !rename_cancelled && !fits) {
    text_setz(&rename_error, "That name is too long");
    dirty(name_view);
    return;
  }
  uint32_t n;
  const char *old = d && d->name.p ? (n = d->name.len, d->name.p) : (n = 0, "");
  if (!d || rename_cancelled || !typed.len || same(typed.p, typed.len, old, n)) {
    rename_cancelled = 0;
    dirty(name_view);
    return;
  }
  rename_saving = 1;
  text_free(&rename_error);
  dirty(name_view);
  wire_q_deck_name q = {typed};
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(renamed, 0, "PATCH", path, WK_Q_DECK_NAME, &q);
}

/* The page goes: the regions of the screen with it. What is the deck's and not the page's stays, when the page
 * is this deck's again (the list drawn again after a mode change, the languages arriving): the typing, the
 * page of notes. Route is already the new page's. */
static void screen_gone(void *ctx) {
  (void)ctx;
  shown = 0;
  cd_undirty(name_view, 0);
  cd_undirty(sub_view, 0);
  cd_undirty(rows_view, 0);
  cd_undirty(danger_view, 0);
  cd_undirty(pager_view, 0);
  renaming = rename_saving = 0;
  text_free(&rename_error);
  danger_state = DANGER_IDLE;
  text_free(&danger_error);
  langs_open = 0;
  if (route != R_DECK || route_deck != deck_id) {
    editing = deleting = -1;
    detect_deck = -1;
    langs_ask++;
    finding = langs_saving = 0;
    text_free(&langs_error);
    notes_known = 0;
    holder_free(&h_notes);
  }
}

/* The screen, then its regions (the name, the languages, the form, the rows, the danger section) and the
 * requests that fill them. */
void deck_build(void) {
  cd_on_free(0, screen_gone, 0);
  const deck *d = deck_by_id(route_deck);
  deck_id = route_deck;
  /* the pair is the deck's own (the list has it); a deck without one is worked out by the server, once a visit */
  if (d->pair.known[0]) {
    langs = d->pair;
    finding = 0;
  } else if (detect_deck != deck_id) {
    char path[48];
    detect_deck = deck_id;
    langs = pick = (lang_pair){"", ""};
    finding = 1;
    deck_path(path, "/languages/detect", 17);
    ask(languages_found, CTX_OF(++langs_ask), "POST", path, WIRE_NONE, 0);
  }
  el("div", "deck-cards");
  shown = 1;
  el("div", "deck-cards-header");
  title_box = el_id("div", "deck-cards-title");
  name_h1 = cd_open_id("h1");
  name_box.parent = name_h1;
  cd_close();
  sub_line = el_id("p", "deck-cards-sub");
  sub.parent = sub_line;
  cd_close();
  cd_close();
  cd_on(el_id("button", "back-btn"), CD_EV_CLICK, back, 0);
  cd_text("← Decks");
  cd_close();
  cd_close();

  el("div", "deck-content");
  form_build(deck_id, &langs, finding);
  list_box = el_id("div", "deck-cards-list");
  el("div", "deck-cards-listhead");
  el_text("h3", 0, "Cards in this deck");
  cd_open("span");
  cd_text_num(d->count);
  cd_name_text(listhead_count = cd_id_new());
  cd_close();
  cd_close();
  cd_close();
  /* Not for the Default deck (id 1): Anki never removes it. Its remove_decks empties Default and
   * resets its name instead (rslib/src/decks/remove.rs), so "delete" would only empty it, and the
   * server refuses it on both transports. */
  danger.parent = 0; /* none, for Default */
  if (deck_id != 1) {
    danger.parent = el_id("section", "deck-danger");
    cd_attr("aria-label", "Delete this deck");
    cd_close();
  }
  cd_close();
  dirty(name_view);
  dirty(sub_view);
  dirty(danger_view);
  ensure_notetypes();
  if (!notes_known || page_notes.offset != want_offset) ask_notes(0);
  dirty(rows_view);
  form_notetypes_known();
}

static void editor_gone(void *ctx) {
  (void)ctx;
  editor_row = -1;
}

static void editor_close(void) {
  if (editor_row < 0) return;
  int32_t row = editor_row;
  cd_region_hide(&editor); /* the panel goes with it */
  cd_set_class(row_li[row], "note-row-wrap");
  cd_set_text_node(row_edit[row], "Edit");
}

static void editor_open(uint32_t i) {
  const wire_note *n = &page_notes.notes[i];
  const notetype *t = notetype_by_id(n->notetype_id);
  if (!t || !row_edit[i] || !cd_region_show(&editor, 1)) return;
  cd_on_free(0, editor_gone, 0);
  editor_row = (int32_t)i;
  cd_set_class(row_li[i], "note-row-wrap is-open");
  cd_set_text_node(row_edit[i], "Close");
  cd_at(row_li[i], 0);
  el("div", "note-row-editor");
  cd_name_open(editor.root);
  panel_build(&editor, n->id, &n->fields, t->fields, t->nfields, &langs);
  cd_close();
  cd_region_end(&editor);
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
  row_li[i] = el_id("li", "note-row-wrap");
  row_edit[i] = 0;
  el("div", "note-row");
  el("span", "note-row-target");
  tmp_text(front, flen);
  cd_close();
  el("span", "note-row-cue");
  if (amgi) {
    wire_str cue = field_named(n, t, "Cue");
    char *c = cd_alloc(cue.len + 1);
    tmp_text(c, strip_tags(c, cue));
    cd_free(c);
  } else {
    el("span", "note-row-type");
    if (t) {
      tmp_text(t->name.p, t->name.len);
    } else {
      char nm[40] = "Note type ";
      tmp_text(nm, 10 + id_dec(nm + 10, n->notetype_id));
    }
    cd_close();
    cd_text(" not an amgi card");
  }
  cd_close();
  el("span", "note-row-clips");
  wire_str cue_clip = audio_src(field_named(n, t, "CueAudio")), target_clip = audio_src(field_named(n, t, "TargetAudio"));
  chip_build(0, cue_clip.p, cue_clip.len, lang_label(langs.known), TONE_CUE);
  chip_build(0, target_clip.p, target_clip.len, lang_label(langs.learning), TONE_TARGET);
  if (amgi && !has_audio) el_text("small", "note-row-noaudio", "no audio yet");
  cd_close();
  if (amgi) {
    cd_id edit = el_id("button", 0);
    cd_attr("type", "button");
    cd_class("note-row-edit");
    cd_on(edit, CD_EV_CLICK, edit_pressed, CTX_OF(i));
    cd_text(open ? "Close" : "Edit");
    cd_name_text(row_edit[i] = cd_id_new());
    cd_close();
  } else {
    el("span", "note-row-edit note-row-edit-off");
    cd_attr("title", "amgi only edits its own note type");
    cd_text("—");
    cd_close();
  }
  cd_id del = el_id("button", 0);
  cd_attr("type", "button");
  cd_class("note-row-delete");
  cd_attr("title", "Delete this card");
  {
    static const char D[] = "Delete ";
    char *label = cd_alloc(sizeof D + flen);
    __builtin_memcpy(label, D, sizeof D - 1);
    __builtin_memcpy(label + sizeof D - 1, front, flen);
    attr_tmp("aria-label", label, (uint32_t)sizeof D - 1 + flen);
    cd_free(label);
  }
  cd_on(del, CD_EV_CLICK, delete_pressed, CTX_OF(i));
  if (deleting == n->id) {
    cd_attr("disabled", "");
    cd_text("…");
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

static void rows_gone(void *ctx) {
  (void)ctx;
  rows_hash = 0;
}

ON_RENDER(rows_view) {
  cd_region_hide(&body); /* the open editor, and every chip, go with it */
  if (!cd_region_show(&body, 1)) return;
  cd_on_free(0, rows_gone, 0);
  cd_at(list_box, pager.shown ? pager.root : 0); /* the pager stays, after the rows */
  if (notes_error.len) {
    el("div", "empty-deck");
    cd_name_open(body.root);
    cd_open("p");
    cd_text("Could not load this deck's notes: ");
    tmp_text(notes_error.p, notes_error.len);
    cd_close();
    cd_close();
  } else if (!notes_known || !notetypes_known || !page_notes.nnotes) {
    el("div", "empty-deck");
    cd_name_open(body.root);
    cd_open("p");
    cd_text(notes_known && notetypes_known && !notes_loading ? "No notes in this deck yet." : "Loading notes…");
    cd_close();
    cd_close();
  } else {
    el("ol", "note-rows");
    cd_name_open(body.root);
    row_li = cd_realloc(row_li, (page_notes.nnotes + 1) * sizeof *row_li);
    row_edit = cd_realloc(row_edit, (page_notes.nnotes + 1) * sizeof *row_edit);
    for (uint32_t i = 0; i < page_notes.nnotes; i++) row_build(i);
    cd_close();
    rows_hash = page_hash();
  }
  /* inside the body's build, so the editor is the body's child whether the body is built by the page or by an answer */
  for (uint32_t i = 0; editing >= 0 && notes_known && i < page_notes.nnotes; i++)
    if (page_notes.notes[i].id == editing) editor_open(i);
  cd_region_end(&body);
  dirty(pager_view);
}

/* The pager under the rows: built when there is more than the one page, then kept, its buttons and its range set from
 * the page each time the rows are drawn (they write only what changed). */
ON_RENDER(pager_view) {
  uint32_t n = notes_known && notetypes_known ? page_notes.nnotes : 0;
  if (!n || (!page_notes.offset && !page_notes.has_more)) {
    cd_region_hide(&pager);
    return;
  }
  int off[2] = {!page_notes.offset || notes_loading, !page_notes.has_more || notes_loading};
  if (!pager.shown && cd_region_show(&pager, 1)) {
    cd_at(list_box, 0);
    el("div", "card-list-pager");
    cd_name_open(pager.root);
    cd_attr("style", "display: flex; justify-content: center; gap: 1rem; align-items: center; margin-top: 1rem;");
    for (int which = 0; which < 2; which++) {
      if (which) {
        cd_open("small");
        cd_attr("style", "opacity: 0.75;");
        text_bound_num(&range_lo, page_notes.offset + 1);
        cd_text("–");
        text_bound_num(&range_hi, page_notes.offset + n);
        cd_close();
      }
      cd_id step = el_id("button", "back-btn");
      if (off[which]) cd_attr("disabled", "");
      bool_bound(which ? &next_off : &prev_off, step, "disabled", off[which]);
      cd_on(step, CD_EV_CLICK, which ? next_pressed : prev_pressed, 0);
      cd_text(which ? "Next →" : "← Prev");
      cd_close();
    }
    cd_close();
    cd_region_end(&pager);
  }
  cd_bound_set_num(&prev_off, off[0]);
  cd_bound_set_num(&next_off, off[1]);
  cd_bound_set_num(&range_lo, page_notes.offset + 1);
  cd_bound_set_num(&range_hi, page_notes.offset + n);
}

/* The danger section's contents: what deleting means, the button (what it is doing, while it is),
 * and why the last try failed. */
ON_RENDER(danger_view) {
  if (!danger.shown && danger.parent && cd_region_show(&danger, 1)) {
    cd_at(danger.parent, 0);
    el("div", "deck-danger-text");
    el_text("h3", 0, "Delete this deck");
    el_text("p", 0, "The deck, its subdecks and every card in them, on every device you sync with.");
    cd_close();
    cd_id del = el_id("button", "deck-danger-btn");
    cd_attr("type", "button");
    bool_bound(&danger_off, del, "disabled", 0);
    cd_on(del, CD_EV_CLICK, deck_delete_pressed, 0);
    text_bound(&danger_label, "Delete deck");
    cd_close();
    cd_region_end(&danger);
  }
  if (!danger.shown) return; /* the Default deck has no such section */
  cd_bound_set(&danger_label, danger_state == DANGER_CHECKING   ? "Checking…"
                              : danger_state == DANGER_DELETING ? "Deleting…"
                                                                : "Delete deck");
  cd_bound_set_num(&danger_off, danger_state != DANGER_IDLE);
  cd_region_hide(&danger_err);
  if (danger_error.len && cd_region_show(&danger_err, 1)) {
    cd_at(danger.parent, 0);
    el("p", "deck-danger-error");
    cd_name_open(danger_err.root);
    cd_attr("role", "alert");
    tmp_text(danger_error.p, danger_error.len);
    cd_close();
    cd_region_end(&danger_err);
  }
}

void deck_decks_changed(void) {
  if (!shown) return;
  const deck *d = deck_by_id(deck_id);
  if (!d) {
    page_show(); /* the deck went: back to the list */
    return;
  }
  if (!renaming) dirty(name_view); /* an open rename keeps what is typed in it; it shows the name again when it closes */
  cd_set_text_node_num(listhead_count, d->count);
  dirty(sub_view);
}

static holder h_write;
static int64_t pending_delete = -1;
static void delete_now(void *ctx) {
  (void)ctx;
  deleting = pending_delete;
  dirty(rows_view); /* the row's button says … while it goes */
  char path[48] = "/notes/";
  path[7 + id_dec(path + 7, deleting)] = 0;
  ask(note_deleted, 0, "DELETE", path, WIRE_NONE, 0);
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
  dirty(danger_view);
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(deck_removed, 0, "DELETE", path, WIRE_NONE, 0);
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

/* answered even when the page went meanwhile: the deck list must not keep a deck that went */
ON_ANSWER(deck_removed) {
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
    dirty(danger_view);
  }
}
ON_ANSWER(summary_answered) {
  if (!shown) return;
  wire_deck_summary s;
  answer a = take(&h_write, WK_DECK_SUMMARY, status, p, len, &s);
  danger_state = DANGER_IDLE;
  if (a.ok) {
    dirty(danger_view);
    deck_delete_ask(&s);
  } else if (a.status == 404) {
    refresh_decks();
  } else {
    char m[600];
    text_set(&danger_error, m, answer_message(&a, m, sizeof m));
    dirty(danger_view);
  }
}
ON_ANSWER(note_deleted) {
  if (!shown) return;
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
    dirty(rows_view);
    confirm_ask("Could not delete the card", m, n, 0, "OK", 0, 0);
  }
}
ON_ANSWER(renamed) {
  if (!shown) return;
  wire_deck_renamed r;
  answer a = take(&h_write, WK_DECK_RENAMED, status, p, len, &r);
  rename_saving = 0;
  if (!a.ok) {
    /* Anki refuses a name another deck has, and so do we: say which, keep the old name */
    char m[600];
    text_set(&rename_error, m, answer_message(&a, m, sizeof m));
  }
  dirty(name_view);
  refresh_decks();
}
ON_ANSWER(notes_answered) {
  if (!shown) return;
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
  dirty(rows_view);
}

/* Called when the note types arrive (state.c): the rows can name their types now. */
void deck_notetypes_known(void) {
  if (!shown) return;
  form_notetypes_known();
  if (notes_known) dirty(rows_view);
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
  dirty(danger_view);
  char path[48] = "/decks/";
  path[7 + id_dec(path + 7, deck_id)] = 0;
  ask(summary_answered, 0, "GET", path, WIRE_NONE, 0);
}
ON_EVENT(rename_pressed) {
  renaming = 1;
  rename_cancelled = 0;
  dirty(name_view);
}
ON_EVENT(name_left) { rename_commit(); }
ON_EVENT(name_key) {
  if (e->key == 13) cd_call(name_input, "blur"); /* Enter: leaving the field saves */
  if (e->key == 27) {                                   /* Escape abandons the edit */
    rename_cancelled = 1;
    renaming = 0;
    dirty(name_view);
  }
}
ON_EVENT(langs_open_pressed) {
  langs_open = 1;
  pick = langs;
  text_free(&langs_error);
  dirty(sub_view);
}
ON_EVENT(langs_cancel_pressed) {
  langs_open = 0;
  text_free(&langs_error);
  dirty(sub_view);
}
/* ctx: 0 the language known, 1 the one learnt. One side cannot take the other's code: the select goes back to its own. */
ON_EVENT(language_changed) {
  char code[8];
  int learning = CTX_INDEX(ctx) == 1;
  uint32_t n;
  char *mine = learning ? pick.learning : pick.known, *other = learning ? pick.known : pick.learning;
  /* the options are the app's own codes: one that does not fit is no language */
  if (!cd_input_whole(learning ? learning_select : known_select, code, sizeof code - 1, &n) || !language_name(code, n))
    return;
  if (same_z(code, n, other)) {
    cd_set_str(learning ? learning_select : known_select, "value", cd_tmp(mine, zlen(mine)));
    return;
  }
  code[n] = 0;
  __builtin_memcpy(mine, code, n + 1);
  pick_sync();
}
ON_EVENT(langs_save_pressed) {
  if (langs_saving || !lang_pair_ok(pick.known, zlen(pick.known), pick.learning, zlen(pick.learning))) return;
  char path[48];
  langs_saving = 1;
  text_free(&langs_error);
  pick_sync();
  wire_q_deck_languages q = {{pick.known, zlen(pick.known)}, {pick.learning, zlen(pick.learning)}};
  deck_path(path, "/languages", 10);
  ask(languages_saved, CTX_OF(++langs_ask), "PUT", path, WK_Q_DECK_LANGUAGES, &q);
}

static int still_open(void *ctx) { return shown && CTX_INDEX(ctx) == langs_ask; }

static holder h_found, h_saved;

ON_ANSWER(languages_found) {
  wire_deck_languages_found f;
  answer a = take(&h_found, WK_DECK_LANGUAGES_FOUND, status, p, len, &f);
  lang_pair got = {"", ""};
  if (a.ok) lang_pair_set(&got, f.known, f.learning);
  if (a.ok && f.stored) deck_pair_set(f.id, &got);
  if (!still_open(ctx)) return;
  finding = 0;
  if (a.ok && f.stored) langs = got;
  else pick = got; /* the guess, or nothing */
  langs_apply();
}

ON_ANSWER(languages_saved) {
  wire_deck_languages r;
  answer a = take(&h_saved, WK_DECK_LANGUAGES, status, p, len, &r);
  lang_pair got;
  if (a.ok) {
    lang_pair_set(&got, r.known, r.learning);
    deck_pair_set(r.id, &got);
  }
  if (!still_open(ctx)) return;
  langs_saving = 0;
  if (a.ok) {
    langs = got;
    langs_open = 0;
    langs_apply();
  } else {
    char m[600];
    text_set(&langs_error, m, answer_message(&a, m, sizeof m));
    dirty(sub_view);
  }
}

/* A deck page for a deck that is not in the list while the collection answers: deleted here, in
 * Anki, or on another device and synced. Said, with the way back, rather than an empty page or a
 * silent jump. Built under page.root as deck_build is. */
void deck_gone_build(void) {
  el("div", "deck-cards");
  el("div", "deck-gone");
  el_text("h1", 0, "This deck no longer exists");
  el_text("p", 0, "It was deleted, here, in Anki, or on another device you sync with.");
  cd_id back_button = el_id("button", "back-btn");
  cd_attr("type", "button");
  cd_on(back_button, CD_EV_CLICK, back, 0);
  cd_text("← Decks");
  cd_close();
  cd_close();
}
