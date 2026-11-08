/* CardForm: one text box and one button; a line a card. (Phase 1 draws it; making cards is phase 4.) */
#include "app.h"

static int shown;
static cd_id box;          /* .card-form-container: its contents follow the note types */
static cd_region inner = {0};
static lang_pair langs;

static const char *lang_label(const char *code) {
  const char *n = language_name(code, zlen(code));
  return n ? n : code;
}

void form_build(int64_t deck_id, const lang_pair *l) {
  (void)deck_id;
  shown = 1;
  langs = *l;
  el(CD_LIT("div"), CD_LIT("card-form-container"));
  cd_name_open(box = cd_id_new());
  inner.parent = box;
  cd_close();
}

void form_forget(void) {
  if (!shown) return;
  shown = 0;
  cd_region_hide(&inner);
  inner.parent = 0;
}

static void form_draw(void) {
  if (!shown) return;
  cd_region_hide(&inner);
  if (!cd_region_show(&inner, 1)) return;
  cd_at(box, 0);
  if (!notetypes_known) {
    el_text(CD_LIT("p"), CD_LIT("card-form-hint"), CD_LIT("Loading…"));
  } else if (!amgi_notetype()) {
    /* With Anki closed the installer makes the note type itself; it is missing only when Anki was
     * open during the install, or it was deleted: one fix either way. */
    el(CD_LIT("p"), CD_LIT("card-form-hint"));
    cd_text(CD_LIT("Restart Anki once and it will add the “" AMGI_NOTETYPE_NAME "” card type to your collection. amgi "
                   "builds every card on that type."));
    cd_close();
  } else {
    el(CD_LIT("div"), CD_LIT("card-form-lead"));
    cd_open(CD_LIT("textarea"));
    cd_attr(CD_LIT("id"), CD_LIT("amgiCardInput"));
    cd_class(CD_LIT("card-form-input"));
    cd_attr(CD_LIT("rows"), CD_LIT("1"));
    {
      static const char A[] = "Type or paste in ", B[] = " or ", C[] = ". One line per card.";
      const char *k = lang_label(langs.known), *l = lang_label(langs.learning);
      char ph[160];
      uint32_t n = 0, kl = zlen(k), ll = zlen(l);
      __builtin_memcpy(ph + n, A, sizeof A - 1);
      n += sizeof A - 1;
      __builtin_memcpy(ph + n, k, kl);
      n += kl;
      __builtin_memcpy(ph + n, B, sizeof B - 1);
      n += sizeof B - 1;
      __builtin_memcpy(ph + n, l, ll);
      n += ll;
      __builtin_memcpy(ph + n, C, sizeof C - 1);
      n += sizeof C - 1;
      cd_str placeholder = CD_LIT("placeholder");
      attr_tmp(placeholder, ph, n);
    }
    if (!ready()) cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_close();
    el(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("card-form-go"));
    cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_text(CD_LIT("Make the card"));
    cd_close();
    cd_close();
  }
  cd_region_end(&inner);
}

void form_notetypes_known(void) { form_draw(); }
void form_langs_changed(const lang_pair *l) {
  langs = *l;
  form_draw();
}
void form_event(const cd_event_rec *e, uint32_t tag) {
  (void)e;
  (void)tag;
}
