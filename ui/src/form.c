/* CardForm: one text box and one button, a line a card, for one line or fifty: the same run, a
 * row each (bulk.c). Enter makes the card of a single line; Shift+Enter starts a second line. */
#include "app.h"

#define MAX_PASTE 65536
#define MAX_LINES 500

static int shown, has_text;
static int64_t form_deck;
static cd_id box, input, go_button, go_text;
static cd_region inner = {0};
static cd_region too_long = {0}; /* the paste is more than MAX_PASTE bytes: said, after the box */
static lang_pair langs;
static uint32_t line_count;

static const char *lang_label(const char *code) {
  const char *n = language_name(code, zlen(code));
  return n ? n : code;
}

static uint32_t placeholder(char *ph) {
  static const char A[] = "Type or paste in ", B[] = " or ", C[] = ". One line per card.";
  const char *k = lang_label(langs.known), *l = lang_label(langs.learning);
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
  return n + sizeof C - 1;
}

void form_build(int64_t deck_id, const lang_pair *l) {
  shown = 1;
  form_deck = deck_id;
  langs = *l;
  box = el_id(CD_LIT("div"), CD_LIT("card-form-container"));
  inner.parent = 0;
  cd_close();
}

void form_forget(void) {
  if (!shown) return;
  shown = 0;
  bulk_forget();
  cd_region_hide(&too_long);
  cd_region_hide(&inner);
}

/* The box's value, whole, into a new MAX_PASTE buffer (the caller frees it), or 0 when it does not
 * fit: then the box says so and makes nothing, so no line of a long paste is dropped unsaid. */
static char *take_text(uint32_t *n) {
  char *v = cd_alloc(MAX_PASTE);
  int fits = input_value(input, v, MAX_PASTE, n);
  if (fits) {
    cd_region_hide(&too_long);
  } else if (cd_region_show(&too_long, 1)) {
    cd_at(box, 0);
    el(CD_LIT("p"), CD_LIT("card-form-error"));
    cd_name_open(too_long.root);
    cd_text(CD_LIT("This is too long to make cards from at once (64 KB at most). Make them in parts."));
    cd_close();
    cd_region_end(&too_long);
  }
  if (fits) return v;
  cd_free(v);
  return 0;
}

/* The button and the box's height follow what is typed: "Make N cards" for several lines, and a
 * box a line taller than its text, up to ten. */
static void follow_text(const char *v, uint32_t n) {
  wire_str t = trim((wire_str){v, n});
  has_text = t.len > 0;
  char *keys = cd_alloc(n + 1);
  line_count = has_text ? paste_lines(v, n, 0, 0, keys) : 0;
  cd_free(keys);
  uint32_t newlines = 0;
  for (uint32_t i = 0; i < n; i++) newlines += v[i] == '\n';
  uint32_t rows = newlines ? (newlines + 2 < 10 ? newlines + 2 : 10) : 1;
  char rn[12];
  cd_str r = CD_LIT("rows");
  cd_set_attr(input, r, cd_tmp(rn, cd_fmt(rn, (int32_t)rows, 0, CD_UNIT_NONE)));
  if (line_count > 1) {
    char t2[32] = "Make ";
    uint32_t k = 5 + cd_fmt(t2 + 5, (int32_t)line_count, 0, CD_UNIT_NONE);
    __builtin_memcpy(t2 + k, " cards", 6);
    cd_set_text(go_text, cd_tmp(t2, k + 6));
  } else {
    cd_set_text(go_text, CD_LIT("Make the card"));
  }
  cd_set_bool(go_button, CD_LIT("disabled"), !ready() || !has_text);
}

ON_EVENT(typed);
ON_EVENT(key_down);
ON_EVENT(go_pressed);

static void form_draw(void) {
  if (!shown) return;
  bulk_forget();
  cd_region_hide(&too_long);
  cd_region_hide(&inner);
  if (!cd_region_show(&inner, 1)) return;
  cd_at(box, 0);
  if (!notetypes_known) {
    el(CD_LIT("p"), CD_LIT("card-form-hint"));
    cd_name_open(inner.root);
    cd_text(CD_LIT("Loading…"));
    cd_close();
  } else if (!amgi_notetype()) {
    /* With Anki closed the installer makes the note type itself; it is missing only when Anki was
     * open during the install, or it was deleted: one fix either way. */
    el(CD_LIT("p"), CD_LIT("card-form-hint"));
    cd_name_open(inner.root);
    cd_text(CD_LIT("Restart Anki once and it will add the “" AMGI_NOTETYPE_NAME "” card type to your collection. amgi "
                   "builds every card on that type."));
    cd_close();
  } else {
    el(CD_LIT("div"), CD_LIT("card-form-lead"));
    cd_name_open(inner.root);
    input = cd_open_id(CD_LIT("textarea"));
    cd_attr(CD_LIT("id"), CD_LIT("amgiCardInput"));
    cd_class(CD_LIT("card-form-input"));
    cd_attr(CD_LIT("rows"), CD_LIT("1"));
    char ph[160];
    cd_str p = CD_LIT("placeholder");
    attr_tmp(p, ph, placeholder(ph));
    if (!ready()) cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_on(input, CD_EV_INPUT, typed, 0);
    cd_on(input, CD_EV_KEYDOWN, key_down, 0);
    cd_close();
    go_button = el_id(CD_LIT("button"), 0);
    cd_attr(CD_LIT("type"), CD_LIT("button"));
    cd_class(CD_LIT("card-form-go"));
    cd_attr(CD_LIT("disabled"), CD_LIT(""));
    cd_on(go_button, CD_EV_CLICK, go_pressed, 0);
    cd_text(CD_LIT("Make the card"));
    cd_name_text(go_text = cd_id_new());
    cd_close();
    cd_close();
  }
  cd_region_end(&inner);
  has_text = 0;
  line_count = 0;
}

void form_notetypes_known(void) { form_draw(); }
void form_langs_changed(const lang_pair *l) {
  langs = *l;
  if (!shown || !inner.shown || !amgi_notetype() || !notetypes_known) return;
  char ph[160];
  cd_str p = CD_LIT("placeholder");
  cd_set_attr(input, p, cd_tmp(ph, placeholder(ph)));
}

static void finished(void) {
  /* the lines are cards now: the box empties */
  cd_set_str(input, CD_LIT("value"), CD_LIT(""));
  follow_text("", 0);
}

static void submit(void) {
  if (!has_text || !amgi_notetype()) return;
  uint32_t n;
  char *v = take_text(&n);
  if (!v) return;
  wire_str *lines = cd_alloc(MAX_LINES * sizeof *lines);
  char *keys = cd_alloc(n + 1);
  uint32_t count = paste_lines(v, n, lines, MAX_LINES, keys);
  if (count > MAX_LINES) count = MAX_LINES;
  bulk_start(box, form_deck, amgi_notetype(), &langs, lines, count, finished);
  cd_free(keys);
  cd_free(lines);
  cd_free(v);
}

ON_EVENT(go_pressed) {
  if (shown) submit();
}
ON_EVENT(typed) {
  if (!shown) return;
  uint32_t n;
  char *v = take_text(&n);
  follow_text(v ? v : "", n); /* too long: no text to make cards of, the button off */
  cd_free(v);
  bulk_forget(); /* typing again puts the last run away */
}
ON_EVENT(key_down) {
  if (!shown || e->key != 13 || (e->mods & CD_MOD_SHIFT)) return;
  /* Enter makes the card of a single line; with a line break already in, it is a new line */
  uint32_t n, breaks = 0;
  char *v = take_text(&n);
  if (!v) return; /* too long: Enter is a new line, as with any text of several */
  for (uint32_t i = 0; i < n; i++) breaks += v[i] == '\n';
  cd_free(v);
  if (!breaks) {
    cd_prevent_default();
    submit();
  }
}
