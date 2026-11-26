/* CardForm: one text box and one button, a line a card, for one line or fifty: the same run, a
 * row each (bulk.c). Enter makes the card of a single line; Shift+Enter starts a second line. */
#include "app.h"

#define MAX_PASTE 65536
#define MAX_LINES 500

static int shown, has_text;
static int64_t form_deck;
static cd_id box, input, go_button, go_text;
static cd_region inner = {.up = &page_region};
static cd_region too_long = {.up = &page_region}; /* the paste is more than MAX_PASTE bytes: said, after the box */
static lang_pair langs;     /* "" known: the deck has no pair, and the form is off */
static int finding;         /* ... because the server is still looking for it */
static uint32_t line_count;

static const char *lang_label(const char *code) {
    const char *n = language_name(code, zlen(code));
    return n ? n : code;
}

static uint32_t placeholder(char *ph) {
    static const char A[] = "Type or paste in ", B[] = " or ", C[] = ". One line per card.";
    if (!langs.known[0]) {
        const char *w = finding ? "Finding this deck's languages…" : "Choose this deck's languages first";
        uint32_t wl = zlen(w);
        __builtin_memcpy(ph, w, wl);
        return wl;
    }
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

ON_RENDER(form_draw);

static void dirty(void) {
    if (shown) cd_dirty(form_draw, 0);
}

static void form_gone(void *ctx) {
    (void)ctx;
    shown = 0;
    cd_undirty(form_draw, 0);
}

void form_build(int64_t deck_id, const lang_pair *l, int finding_pair) {
    shown = 1;
    finding = finding_pair;
    cd_on_free(0, form_gone, 0);
    form_deck = deck_id;
    langs = *l;
    box = el_id("div", "card-form-container");
    cd_close();
}

/* The box's value, whole, into a new MAX_PASTE buffer (the caller frees it), or 0 when it does not
 * fit: then the box says so and makes nothing, so no line of a long paste is dropped unsaid. */
static char *take_text(uint32_t *n) {
    char *v = cd_alloc(MAX_PASTE);
    int fits = cd_input_whole(input, v, MAX_PASTE, n);
    if (fits) {
        cd_region_hide(&too_long);
    } else if (cd_region_show(&too_long, 1)) {
        cd_at(box, 0);
        el("p", "card-form-error");
        cd_name_open(too_long.root);
        cd_text("This is too long to make cards from at once (64 KB at most). Make them in parts.");
        cd_close();
        cd_region_end(&too_long);
    }
    if (fits) return v;
    cd_free(v);
    *n = 0; /* the whole length of what did not fit is no text to read */
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
    cd_set_attr(input, "rows", cd_tmp(rn, cd_fmt(rn, (int32_t)rows, 0, CD_UNIT_NONE)));
    if (line_count > 1) {
        char t2[32] = "Make ";
        uint32_t k = 5 + cd_fmt(t2 + 5, (int32_t)line_count, 0, CD_UNIT_NONE);
        __builtin_memcpy(t2 + k, " cards", 6);
        cd_set_text_node(go_text, cd_tmp(t2, k + 6));
    } else {
        cd_set_text_node(go_text, "Make the card");
    }
    cd_set_bool(go_button, "disabled", !ready() || !has_text);
}

ON_EVENT(typed);
ON_EVENT(key_down);
ON_EVENT(go_pressed);

ON_RENDER(form_draw) {
    bulk_discard();
    cd_region_hide(&too_long);
    cd_region_hide(&inner);
    if (!cd_region_show(&inner, 1)) return;
    cd_at(box, 0);
    if (!notetypes_known) {
        el("p", "card-form-hint");
        cd_name_open(inner.root);
        cd_text("Loading…");
        cd_close();
    } else if (!amgi_notetype()) {
        /* With Anki closed the installer makes the note type itself; it is missing only when Anki was
         * open during the install, or it was deleted: one fix either way. */
        el("p", "card-form-hint");
        cd_name_open(inner.root);
        cd_text("Restart Anki once and it will add the “" AMGI_NOTETYPE_NAME "” card type to your collection. amgi "
                "builds every card on that type.");
        cd_close();
    } else {
        el("div", "card-form-lead");
        cd_name_open(inner.root);
        input = cd_open_id("textarea");
        cd_attr("id", "amgiCardInput");
        cd_class("card-form-input");
        cd_attr("rows", "1");
        char ph[160];
        attr_tmp("placeholder", ph, placeholder(ph));
        if (!ready() || !langs.known[0]) cd_attr("disabled", "");
        cd_on(input, CD_EV_INPUT, typed, 0);
        cd_on(input, CD_EV_KEYDOWN, key_down, 0);
        cd_close();
        go_button = el_id("button", 0);
        cd_attr("type", "button");
        cd_class("card-form-go");
        cd_attr("disabled", "");
        cd_on(go_button, CD_EV_CLICK, go_pressed, 0);
        cd_text("Make the card");
        cd_name_text(go_text = cd_id_new());
        cd_close();
        cd_close();
    }
    cd_region_end(&inner);
    has_text = 0;
    line_count = 0;
}

void form_notetypes_known(void) { dirty(); }
void form_langs_changed(const lang_pair *l, int finding_pair) {
    langs = *l;
    finding = finding_pair;
    if (!shown || !inner.shown || !amgi_notetype() || !notetypes_known) return;
    cd_set_bool(input, "disabled", !ready() || !langs.known[0]);
    char ph[160];
    cd_set_attr(input, "placeholder", cd_tmp(ph, placeholder(ph)));
}

static void finished(void) {
    /* the lines are cards now: the box empties. The box may be about to be drawn again (the note types arrived in this
     * entry): draw it now, so input names the box that is there, not the one the draw takes away. */
    cd_render_now();
    cd_set_str(input, "value", "");
    follow_text("", 0);
}

static void submit(void) {
    if (!has_text || !amgi_notetype() || !langs.known[0]) return;
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
    if (!v) {
        cd_set_attr(input, "rows", "10"); /* and the box at its tallest, as for any long paste */
    }
    cd_free(v);
    bulk_discard(); /* typing again puts the last run away */
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
