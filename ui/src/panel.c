/* CardPanel: one amgi card, editable in its row of the deck page. No Save button: a field writes
 * itself back when you leave it, and only if it changed. Redo records one side again from the text
 * in its field now; Delete asks first, in the page. */
#include "app.h"

enum { K_TARGET, K_CUE, K_NOTES, KEYS };

static int open_;
static int64_t note_id;
static text *fields;
static uint32_t nfields;
static amgi_fields idx;
static lang_pair langs;
static int busy;          /* 0, or the side being recorded again: 1 target, 2 cue */
static int deleting;
static text error;
static cd_id root, foot, clips_box, inputs[KEYS], redo_btn[2];
/* The buttons' words and whether they are off, set on every draw of labels_view and written only when changed. */
static cd_bound redo_label[2], redo_off[2], delete_label, delete_off;
static cd_region err = {0};       /* in the editor, which panel_build is given */
static cd_region *owner;          /* the editor: the region the panel's chips go with */
static int32_t chips[2] = {-1, -1};
static holder h;

static int32_t index_of_key(uint32_t k) { return k == K_TARGET ? idx.target : k == K_CUE ? idx.cue : idx.notes; }
static const char *name_of(const char *code) {
  const char *n = language_name(code, zlen(code));
  return n ? n : code;
}

ON_RENDER(error_view);
ON_RENDER(labels_view);

/* The views are renders. Two guards, for two vectors: dirty() asks only while the panel is open, which covers an ask
 * made after the editor went (a late answer); the cd_undirty in gone covers an ask made earlier in the same entry. */
static void dirty(cd_render_fn view) {
  if (open_) cd_dirty(view, 0);
}

ON_RENDER(error_view) {
  cd_region_hide(&err);
  if (!error.len || !cd_region_show(&err, 1)) return;
  cd_at(root, foot);
  el(CD_LIT("p"), CD_LIT("card-panel-error"));
  cd_name_open(err.root);
  tmp_text(error.p, error.len);
  cd_close();
  cd_region_end(&err);
}

static void set_error(const answer *a) {
  char m[600];
  text_set(&error, m, answer_message(a, m, sizeof m));
  dirty(error_view);
}

ON_RENDER(labels_view) {
  for (int s = 0; s < 2; s++) {
    if (busy == s + 1) {
      cd_bound_set(&redo_label[s], CD_LIT("Redoing…"));
    } else {
      static const char R[] = "Redo ";
      const char *n = name_of(s ? langs.known : langs.learning);
      char t[64];
      uint32_t l = zlen(n);
      __builtin_memcpy(t, R, sizeof R - 1);
      __builtin_memcpy(t + sizeof R - 1, n, l);
      cd_bound_set_bytes(&redo_label[s], t, (uint32_t)sizeof R - 1 + l);
    }
    cd_bound_set_num(&redo_off[s], busy != 0);
  }
  cd_bound_set(&delete_label, deleting ? CD_LIT("Deleting…") : CD_LIT("Delete card"));
  cd_bound_set_num(&delete_off, deleting);
}

static wire_str clip_of(int32_t i) {
  if (i < 0 || (uint32_t)i >= nfields) return (wire_str){"", 0};
  return audio_src((wire_str){fields[i].p, fields[i].len});
}

ON_ANSWER(saved);
ON_ANSWER(clip_answered);
ON_ANSWER(deleted);
ON_EVENT(field_left);
ON_EVENT(field_key);
ON_EVENT(redo_target);
ON_EVENT(redo_cue);
ON_EVENT(delete_pressed);

static void gone(void *ctx);

/* Built inside the open row's .note-row-editor, while editor builds: the panel is the editor's, and goes
 * with it. fields are the note's, copied. */
void panel_build(cd_region *editor, int64_t id, const wire_strs *f, const text *names, uint32_t nnames,
                 const lang_pair *l) {
  owner = err.up = editor;
  cd_on_free(0, gone, 0);
  open_ = 1;
  note_id = id;
  langs = *l;
  idx = amgi_fields_of(names, nnames);
  nfields = f->n;
  fields = cd_alloc((nfields ? nfields : 1) * sizeof *fields);
  for (uint32_t i = 0; i < nfields; i++) {
    fields[i] = (text){0, 0};
    text_set(&fields[i], f->v[i].p, f->v[i].len);
  }
  busy = deleting = 0;
  text_free(&error);

  root = el_id(CD_LIT("div"), CD_LIT("card-panel"));
  el(CD_LIT("div"), CD_LIT("card-panel-fields"));
  for (uint32_t k = 0; k < KEYS; k++) {
    int32_t i = index_of_key(k);
    inputs[k] = 0;
    if (i < 0) continue;
    el(CD_LIT("label"), CD_LIT("card-panel-field"));
    el(CD_LIT("span"), CD_LIT("card-panel-label"));
    if (k == K_NOTES) {
      cd_text(CD_LIT("Notes"));
      el_text(CD_LIT("em"), 0, CD_LIT(" optional"));
    } else {
      const char *n = name_of(k == K_TARGET ? langs.learning : langs.known);
      tmp_text(n, zlen(n));
    }
    cd_close();
    inputs[k] = cd_open_id(CD_LIT("input"));
    cd_attr(CD_LIT("type"), CD_LIT("text"));
    cd_class(k == K_TARGET ? CD_LIT("card-panel-value card-panel-value-big") : CD_LIT("card-panel-value"));
    cd_str value = CD_LIT("value");
    attr_tmp(value, fields[i].p, fields[i].len);
    cd_attr(CD_LIT("placeholder"), k == K_NOTES ? CD_LIT("anything you want on the answer") : CD_LIT(""));
    cd_on(inputs[k], CD_EV_FOCUSOUT, field_left, CTX_OF(k));
    cd_on(inputs[k], CD_EV_KEYDOWN, field_key, CTX_OF(k));
    cd_close();
    cd_close();
  }
  cd_close();

  clips_box = el_id(CD_LIT("div"), CD_LIT("card-panel-clips"));
  wire_str cue = clip_of(idx.cue_audio), target = clip_of(idx.target_audio);
  chips[0] = chip_build(0, cue.p, cue.len, name_of(langs.known), TONE_CUE);
  chips[1] = chip_build(0, target.p, target.len, name_of(langs.learning), TONE_TARGET);
  for (int s = 0; s < 2; s++) {
    redo_btn[s] = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("card-panel-redo"));
    cd_on(redo_btn[s], CD_EV_CLICK, s ? redo_cue : redo_target, 0);
    cd_text(CD_LIT(" "));
    cd_id redo_text = cd_id_new();
    cd_name_text(redo_text);
    cd_bind_text(&redo_label[s], redo_text);
    cd_bind_bool(&redo_off[s], redo_btn[s], CD_LIT("disabled"));
    cd_bound_shows_num(&redo_off[s], 0);
    cd_close();
  }
  cd_close();

  foot = el_id(CD_LIT("div"), CD_LIT("card-panel-foot"));
  el_text(CD_LIT("span"), 0, CD_LIT("Changes save as you make them, straight into Anki."));
  cd_id delete_btn = el_id(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("card-panel-delete"));
  cd_on(delete_btn, CD_EV_CLICK, delete_pressed, 0);
  cd_text(CD_LIT("Delete card"));
  cd_id delete_text = cd_id_new();
  cd_name_text(delete_text);
  cd_bind_text(&delete_label, delete_text);
  cd_bound_shows(&delete_label, CD_LIT("Delete card"));
  cd_bind_bool(&delete_off, delete_btn, CD_LIT("disabled"));
  cd_bound_shows_num(&delete_off, 0);
  cd_close();
  cd_close();
  cd_close();
  dirty(labels_view);
}

/* The editor goes: the error and the chips with it. */
static void gone(void *ctx) {
  (void)ctx;
  open_ = 0;
  cd_undirty(error_view, 0);
  cd_undirty(labels_view, 0);
  chips[0] = chips[1] = -1;
  for (uint32_t i = 0; i < nfields; i++) text_free(&fields[i]);
  cd_free(fields);
  fields = 0;
  nfields = 0;
}

int panel_open_for(int64_t id) { return open_ && note_id == id; }

static void save(void) {
  wire_str *v = cd_alloc((nfields ? nfields : 1) * sizeof *v);
  for (uint32_t i = 0; i < nfields; i++) v[i] = (wire_str){fields[i].p, fields[i].len};
  wire_q_note_update q = {{v, nfields}, {langs.learning, zlen(langs.learning)}, idx.target >= 0 ? idx.target : WIRE_ABSENT};
  char path[48] = "/notes/";
  path[7 + id_dec(path + 7, note_id)] = 0;
  ask(saved, 0, "PATCH", path, WK_Q_NOTE_UPDATE, &q);
  cd_free(v);
}

static void commit(uint32_t k) {
  int32_t i = index_of_key(k);
  if (i < 0 || (uint32_t)i >= nfields || !inputs[k]) return;
  char buf[4096];
  uint32_t n;
  if (!input_value(inputs[k], buf, sizeof buf, &n)) {
    text_setz(&error, "This field is too long to save");
    dirty(error_view);
    return;
  }
  text_free(&error);
  dirty(error_view);
  if (same(buf, n, fields[i].p, fields[i].len)) return;
  text_set(&fields[i], buf, n);
  save();
}

static void redo(int side) {
  int32_t ti = side ? idx.cue : idx.target, ai = side ? idx.cue_audio : idx.target_audio;
  if (ti < 0 || ai < 0 || busy || (uint32_t)ti >= nfields) return;
  char *t = cd_alloc(fields[ti].len + 1);
  uint32_t n = strip_tags(t, (wire_str){fields[ti].p, fields[ti].len});
  if (!n) {
    cd_free(t);
    return;
  }
  busy = side + 1;
  text_free(&error);
  dirty(error_view);
  dirty(labels_view);
  const char *lang = side ? langs.known : langs.learning;
  wire_q_audio q = {{t, n}, {lang, zlen(lang)}, 1};
  ask(clip_answered, CTX_OF(side), "POST", "/audio", WK_Q_AUDIO, &q);
  cd_free(t);
}

static void removed(void *ctx) {
  (void)ctx;
  deleting = 1;
  dirty(labels_view);
  char path[48] = "/notes/";
  path[7 + id_dec(path + 7, note_id)] = 0;
  ask(deleted, 0, "DELETE", path, WIRE_NONE, 0);
}

/* ctx: the field's key (K_*) */
ON_EVENT(field_key) {
  if (open_ && e->key == 13) cd_call(inputs[CTX_INDEX(ctx)], CD_LIT("blur")); /* Enter leaves the field: it saves */
}
ON_EVENT(field_left) {
  if (open_) commit(CTX_INDEX(ctx));
}
ON_EVENT(redo_target) {
  if (open_) redo(0);
}
ON_EVENT(redo_cue) {
  if (open_) redo(1);
}
ON_EVENT(delete_pressed) {
  if (!open_ || deleting) return;
  int32_t ti = idx.target;
  char *t = cd_alloc(ti >= 0 && (uint32_t)ti < nfields ? fields[ti].len + 1 : 1);
  uint32_t n = ti >= 0 && (uint32_t)ti < nfields ? strip_tags(t, (wire_str){fields[ti].p, fields[ti].len}) : 0;
  confirm_ask("Delete this card?", t, n, "Its review history goes too, on every device you sync with.", "Delete", removed,
              0);
  cd_free(t);
}

ON_ANSWER(saved) {
  if (!open_) return;
  wire_note_changed c;
  answer a = take(&h, WK_NOTE_CHANGED, status, p, len, &c);
  if (!a.ok) set_error(&a);
}
/* ctx: the side recorded again, 0 the target, 1 the cue */
ON_ANSWER(clip_answered) {
  if (!open_) return;
  int side = (int)CTX_INDEX(ctx);
  wire_clip c;
  answer a = take(&h, WK_CLIP, status, p, len, &c);
  busy = 0;
  if (a.ok) {
    int32_t ai = side ? idx.cue_audio : idx.target_audio;
    if (ai >= 0 && (uint32_t)ai < nfields) {
      text_set(&fields[ai], c.reference.p, c.reference.len);
      save();
      /* the chip plays the new take: built again in its place (React's kept the old clip's bytes) */
      int32_t s = side ? 0 : 1;
      cd_id before = s == 0 && chips[1] >= 0 ? chip_node(chips[1]) : redo_btn[0];
      chip_drop(chips[s]);
      cd_at(clips_box, before);
      /* no region builds now: the editor owns the new chip, which frees its own node */
      chips[s] = chip_build(owner, c.filename.p, c.filename.len, name_of(side ? langs.known : langs.learning),
                            side ? TONE_CUE : TONE_TARGET);
    }
  } else {
    set_error(&a);
  }
  dirty(labels_view);
}
ON_ANSWER(deleted) {
  if (!open_) return;
  wire_note_changed c;
  answer a = take(&h, WK_NOTE_CHANGED, status, p, len, &c);
  if (a.ok) {
    deck_note_removed(note_id);
  } else {
    deleting = 0;
    set_error(&a);
    dirty(labels_view);
  }
}
