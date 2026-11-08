/* The deck screen (CardList, DeckName, DeckLanguages): the deck's header with its two languages, the
 * card form, and the notes a page at a time, each row with its clips. */
#include "app.h"

enum { A_BACK = 1, A_PREV, A_NEXT, A_LANGS_OPEN, A_LANGS_DONE, A_KNOWN, A_LEARNING, A_EDIT, A_DELETE, A_RENAME };
enum { T_NOTES = 1 };
#define PAGE_SIZE 20

static int shown, langs_known, notes_loading, notes_known;
static int64_t deck_id = -1;
static lang_pair langs = {"en", "ko"};
static int langs_open;
static holder h_notes;
static wire_notes page_notes;     /* the page on screen; its strings live in h_notes */
static text notes_error;
static uint32_t want_offset;
static cd_id name_text, sub_line, listhead_count, list_box;
static cd_region sub = {0};       /* the count and the languages: all the children of p.deck-cards-sub */
static cd_region body = {0};      /* div.empty-deck or ol.note-rows */
static cd_region pager = {0};
static cd_id known_select, learning_select;
static int32_t *row_chips;        /* the chips in the rows, forgotten with them */
static uint32_t nrow_chips;

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
    el(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    listen_click(TAG(M_DECK, A_LANGS_OPEN, 0));
    cd_text(CD_LIT("Change"));
    cd_close();
  } else {
    for (int which = 0; which < 2; which++) {
      const char *cur = which ? langs.learning : langs.known;
      cd_open(CD_LIT("select"));
      cd_attr(CD_LIT("aria-label"), which ? CD_LIT("Language you are learning") : CD_LIT("Language you already know"));
      cd_id sel = listen_as(CD_EV_CHANGE, TAG(M_DECK, which ? A_LEARNING : A_KNOWN, 0));
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
    el(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    listen_click(TAG(M_DECK, A_LANGS_DONE, 0));
    cd_text(CD_LIT("Done"));
    cd_close();
  }
  cd_close();
  cd_region_end(&sub);
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
  el(CD_LIT("div"), CD_LIT("deck-cards-title"));
  cd_open(CD_LIT("h1"));
  el(CD_LIT("button"), CD_LIT("deck-name-button"));
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_attr(CD_LIT("title"), CD_LIT("Rename this deck"));
  listen_click(TAG(M_DECK, A_RENAME, 0));
  cd_text(d->name);
  cd_name(name_text = cd_id_new());
  cd_close();
  cd_close();
  el(CD_LIT("p"), CD_LIT("deck-cards-sub"));
  cd_name_open(sub_line = cd_id_new());
  sub.parent = sub_line;
  cd_close();
  cd_close();
  el(CD_LIT("button"), CD_LIT("back-btn"));
  listen_click(TAG(M_DECK, A_BACK, 0));
  cd_text(CD_LIT("← Decks"));
  cd_close();
  cd_close();

  el(CD_LIT("div"), CD_LIT("deck-content"));
  form_build(deck_id, &langs);
  el(CD_LIT("div"), CD_LIT("deck-cards-list"));
  cd_name_open(list_box = cd_id_new());
  el(CD_LIT("div"), CD_LIT("deck-cards-listhead"));
  el_text(CD_LIT("h3"), 0, CD_LIT("Cards in this deck"));
  cd_open(CD_LIT("span"));
  cd_text_num(d->count);
  cd_name(listhead_count = cd_id_new());
  cd_close();
  cd_close();
  cd_close();
  cd_close();
}

static void rows_forget(void) {
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
  form_forget();
  langs_open = 0;
  if (route != R_DECK || route_deck != deck_id) {
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

  el(CD_LIT("li"), CD_LIT("note-row-wrap"));
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
    el(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("note-row-edit"));
    listen_click(TAG(M_DECK, A_EDIT, i));
    cd_text(CD_LIT("Edit"));
    cd_close();
  } else {
    el(CD_LIT("span"), CD_LIT("note-row-edit note-row-edit-off"));
    cd_attr(CD_LIT("title"), CD_LIT("amgi only edits its own note type"));
    cd_text(CD_LIT("—"));
    cd_close();
  }
  el(CD_LIT("button"), 0);
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
  listen_click(TAG(M_DECK, A_DELETE, i));
  icon(ICON_TRASH, 0, 0);
  /* @heroicons/react passes aria-hidden="true" through as the icon's own attribute: it is there */
  cd_close();
  cd_close();
  cd_close();
  cd_free(front);
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
    for (uint32_t i = 0; i < page_notes.nnotes; i++) row_build(i);
    cd_close();
  }
  cd_region_end(&body);

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
    el(CD_LIT("button"), CD_LIT("back-btn"));
    int off = which ? !page_notes.has_more || notes_loading : !page_notes.offset || notes_loading;
    if (off) cd_attr(CD_LIT("disabled"), CD_LIT(""));
    listen_click(TAG(M_DECK, which ? A_NEXT : A_PREV, 0));
    cd_text(which ? CD_LIT("Next →") : CD_LIT("← Prev"));
    cd_close();
  }
  cd_close();
  cd_region_end(&pager);
}

void deck_after(void) {
  if (!langs_known) return;
  sub_build();
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
  cd_set_text(name_text, d->name);
  cd_set_text_num(listhead_count, d->count);
  sub_build();
}

void deck_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (token != T_NOTES || !shown) return;
  answer a = take(&h_notes, WK_NOTES, status, p, len, &page_notes);
  notes_loading = 0;
  if (a.ok) {
    notes_known = 1;
    text_free(&notes_error);
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

void deck_event(const cd_event_rec *e, uint32_t tag) {
  (void)e;
  if (TAG_MODULE(tag) != M_DECK) return; /* the form, the panel, the run and the modal: later phases */
  char code[8];
  switch (TAG_ACTION(tag)) {
  case A_BACK: go("/decks", 6); break;
  case A_PREV:
    if (page_notes.offset && !notes_loading) ask_notes(page_notes.offset > PAGE_SIZE ? page_notes.offset - PAGE_SIZE : 0);
    break;
  case A_NEXT: if (page_notes.has_more && !notes_loading) ask_notes(page_notes.offset + PAGE_SIZE); break;
  case A_LANGS_OPEN: langs_open = 1; sub_build(); break;
  case A_LANGS_DONE: langs_open = 0; sub_build(); break;
  case A_KNOWN: case A_LEARNING: {
    int learning = TAG_ACTION(tag) == A_LEARNING;
    uint32_t n = cd_input_value(learning ? learning_select : known_select, code, sizeof code - 1);
    if (!language_name(code, n)) break;
    code[n] = 0;
    __builtin_memcpy(learning ? langs.learning : langs.known, code, n + 1);
    deck_langs_save(deck_id, &langs);
    form_langs_changed(&langs);
    rows_build(); /* the chips carry the language names */
    break;
  }
  }
}
