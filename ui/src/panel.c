/* CardPanel: one amgi card, editable in its row of the deck page. No Save button: a field writes
 * itself back when you leave it, and only if it changed. Redo records one side again from the text
 * in its field now; Delete asks first, in the page. */
#include "app.h"

enum { A_FIELD_KEY = 1, A_FIELD_BLUR, A_REDO_TARGET, A_REDO_CUE, A_DELETE };
enum { T_SAVE = 1, T_CLIP, T_DELETE };
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
static cd_id root, foot, clips_box, inputs[KEYS], redo_text[2], redo_btn[2], delete_text, delete_btn;
static cd_region err = {0};
static int32_t chips[2] = {-1, -1};
static holder h;

static int32_t index_of_key(uint32_t k) { return k == K_TARGET ? idx.target : k == K_CUE ? idx.cue : idx.notes; }
static const char *name_of(const char *code) {
  const char *n = language_name(code, zlen(code));
  return n ? n : code;
}

static void error_view(void) {
  cd_region_hide(&err);
  if (!open_ || !error.len || !cd_region_show(&err, 1)) return;
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
  error_view();
}

static void labels_view(void) {
  for (int s = 0; s < 2; s++) {
    if (busy == s + 1) {
      cd_set_text(redo_text[s], CD_LIT("Redoing…"));
    } else {
      static const char R[] = "Redo ";
      const char *n = name_of(s ? langs.known : langs.learning);
      char t[64];
      uint32_t l = zlen(n);
      __builtin_memcpy(t, R, sizeof R - 1);
      __builtin_memcpy(t + sizeof R - 1, n, l);
      cd_set_text(redo_text[s], cd_tmp(t, (uint32_t)sizeof R - 1 + l));
    }
    cd_set_bool(redo_btn[s], CD_LIT("disabled"), busy != 0);
  }
  cd_set_text(delete_text, deleting ? CD_LIT("Deleting…") : CD_LIT("Delete card"));
  cd_set_bool(delete_btn, CD_LIT("disabled"), deleting);
}

static wire_str clip_of(int32_t i) {
  if (i < 0 || (uint32_t)i >= nfields) return (wire_str){"", 0};
  return audio_src((wire_str){fields[i].p, fields[i].len});
}

/* Built inside the open row's .note-row-editor; fields are the note's, copied. */
void panel_build(int64_t id, const wire_strs *f, const text *names, uint32_t nnames, const lang_pair *l) {
  panel_forget();
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
    cd_open(CD_LIT("input"));
    cd_attr(CD_LIT("type"), CD_LIT("text"));
    cd_class(k == K_TARGET ? CD_LIT("card-panel-value card-panel-value-big") : CD_LIT("card-panel-value"));
    cd_str value = CD_LIT("value");
    attr_tmp(value, fields[i].p, fields[i].len);
    cd_attr(CD_LIT("placeholder"), k == K_NOTES ? CD_LIT("anything you want on the answer") : CD_LIT(""));
    inputs[k] = listen_as(CD_EV_FOCUSOUT, TAG(M_PANEL, A_FIELD_BLUR, k));
    cd_listen(inputs[k], CD_EV_KEYDOWN);
    cd_close();
    cd_close();
  }
  cd_close();

  clips_box = el_id(CD_LIT("div"), CD_LIT("card-panel-clips"));
  wire_str cue = clip_of(idx.cue_audio), target = clip_of(idx.target_audio);
  chips[0] = chip_build(cue.p, cue.len, name_of(langs.known), TONE_CUE);
  chips[1] = chip_build(target.p, target.len, name_of(langs.learning), TONE_TARGET);
  for (int s = 0; s < 2; s++) {
    el(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("card-panel-redo"));
    redo_btn[s] = listen_as(CD_EV_CLICK, TAG(M_PANEL, s ? A_REDO_CUE : A_REDO_TARGET, 0));
    cd_text(CD_LIT(" "));
    cd_name(redo_text[s] = cd_id_new());
    cd_close();
  }
  cd_close();

  foot = el_id(CD_LIT("div"), CD_LIT("card-panel-foot"));
  el_text(CD_LIT("span"), 0, CD_LIT("Changes save as you make them, straight into Anki."));
  el(CD_LIT("button"), 0);
  cd_attr(CD_LIT("type"), CD_LIT("button"));
  cd_class(CD_LIT("card-panel-delete"));
  delete_btn = listen_as(CD_EV_CLICK, TAG(M_PANEL, A_DELETE, 0));
  cd_text(CD_LIT("Delete card"));
  cd_name(delete_text = cd_id_new());
  cd_close();
  cd_close();
  cd_close();
}

/* Once the rows' region has closed: the labels that need the panel's own state. */
void panel_after(void) {
  if (open_) labels_view();
}

void panel_forget(void) {
  if (!open_) return;
  open_ = 0;
  cd_region_hide(&err);
  for (int s = 0; s < 2; s++) {
    chip_forget(chips[s]);
    chips[s] = -1;
  }
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
  ask(M_PANEL, T_SAVE, "PATCH", path, WK_Q_NOTE_UPDATE, &q);
  cd_free(v);
}

static void commit(uint32_t k) {
  int32_t i = index_of_key(k);
  if (i < 0 || (uint32_t)i >= nfields || !inputs[k]) return;
  char buf[4096];
  uint32_t n = cd_input_value(inputs[k], buf, sizeof buf);
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
  error_view();
  labels_view();
  const char *lang = side ? langs.known : langs.learning;
  wire_q_audio q = {{t, n}, {lang, zlen(lang)}, 1};
  ask(M_PANEL, T_CLIP | (uint32_t)side << 8, "POST", "/audio", WK_Q_AUDIO, &q);
  cd_free(t);
}

static void removed(void *ctx) {
  (void)ctx;
  deleting = 1;
  labels_view();
  char path[48] = "/notes/";
  path[7 + id_dec(path + 7, note_id)] = 0;
  ask(M_PANEL, T_DELETE, "DELETE", path, WIRE_NONE, 0);
}

void panel_event(const cd_event_rec *e, uint32_t tag) {
  if (!open_) return;
  switch (TAG_ACTION(tag)) {
  case A_FIELD_BLUR:
    if (e->type == CD_EV_KEYDOWN) {
      if (e->key == 13) cd_call(inputs[TAG_INDEX(tag)], CD_LIT("blur")); /* Enter leaves the field: it saves */
    } else {
      commit(TAG_INDEX(tag));
    }
    break;
  case A_REDO_TARGET: redo(0); break;
  case A_REDO_CUE: redo(1); break;
  case A_DELETE: {
    if (deleting) break;
    int32_t ti = idx.target;
    char *t = cd_alloc(ti >= 0 && (uint32_t)ti < nfields ? fields[ti].len + 1 : 1);
    uint32_t n = ti >= 0 && (uint32_t)ti < nfields ? strip_tags(t, (wire_str){fields[ti].p, fields[ti].len}) : 0;
    confirm_ask("Delete this card?", t, n, "Its review history goes too, on every device you sync with.", "Delete", removed, 0);
    cd_free(t);
    break;
  }
  }
}

void panel_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len) {
  if (!open_) return;
  switch (token & 0xff) {
  case T_SAVE: {
    wire_note_changed c;
    answer a = take(&h, WK_NOTE_CHANGED, status, p, len, &c);
    if (!a.ok) set_error(&a);
    break;
  }
  case T_CLIP: {
    int side = (int)(token >> 8);
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
        cd_id old = chips[s] >= 0 ? chip_node(chips[s]) : 0;
        cd_id before = s == 0 && chips[1] >= 0 ? chip_node(chips[1]) : redo_btn[0];
        chip_forget(chips[s]);
        if (old) cd_remove(old);
        cd_at(clips_box, before);
        chips[s] = chip_build(c.filename.p, c.filename.len, name_of(side ? langs.known : langs.learning),
                              side ? TONE_CUE : TONE_TARGET);
      }
    } else {
      set_error(&a);
    }
    labels_view();
    break;
  }
  case T_DELETE: {
    wire_note_changed c;
    answer a = take(&h, WK_NOTE_CHANGED, status, p, len, &c);
    if (a.ok) {
      deck_note_removed(note_id);
    } else {
      deleting = 0;
      set_error(&a);
      labels_view();
    }
    break;
  }
  }
}
