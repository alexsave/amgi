/* POST /decks/:id/languages/detect: the languages of a deck that has no stored pair, worked out once and stored when they are
 * certain (the order of truth is the design's: deck-languages-design.md, "A deck with no pair").
 *
 *   a. the deck has a pair: it is the answer, found_by "stored", and nothing is read or asked.
 *   b. the deck's own notes: when the amgi Listening note type's Language field says one known code in every note that has
 *      one, that is the learning language as FACT. No guess is involved.
 *   c. one text request to the cards' model (cards.c card_detect_deck_languages) when a key is set and the deck has a note. The
 *      answer is stored only when it is high confidence, both codes are the language table's, they differ, and learning is the
 *      fact when there is one. found_by is "notes" when there was a fact (it decided learning, and Gemini only supplied
 *      known), else "gemini".
 *   d. otherwise nothing is stored: stored 0, and known and learning are only a guess for the page to preselect (the fact for
 *      learning, else Gemini's code when it is a table's; "" for each when there is none). Nothing is ever defaulted.
 *
 * A failed or refused Gemini call is not this route's failure: it is logged and the answer is d, so the page lets the person
 * pick. */
#include <string.h>

#include "amgi.h"
#include "cards.h"
#include "lang.h"
#include "messages.h"
#include "util/log.h"

#define SAMPLE 10

/* The learning language the deck's amgi Listening notes agree on, or "" (no such note type, no note with a language, one that is
 * not a table's code, or two that differ). */
static str notes_fact(arena *a, const amgi_ops *o, double deck, const col_notetype *nts, size_t nnt) {
    const col_notetype *nt = NULL;
    for (size_t i = 0; i < nnt && !nt; i++)
        if (str_eq_c(nts[i].name, AMGI_NOTETYPE_NAME)) nt = &nts[i];
    if (!nt) return S("");
    amgi_fields idx = amgi_field_indexes(a, nt);
    if (idx.language < 0) return S("");
    str *values;
    size_t n;
    col_err e = {0};
    if (ops_field_values(a, o, deck, (double)nt->id, idx.language, &values, &n, &e)) return S("");
    str fact = S("");
    for (size_t i = 0; i < n; i++) {
        str v = js_trim(values[i]);
        if (!v.n) continue;
        if (!lang_known(v.p, (uint32_t)v.n) || (fact.n && !str_eq(fact, v))) return S("");
        fact = v;
    }
    return fact;
}

/* Gemini's code when it is a table's, else "". */
static str known_code(str code) { return lang_known(code.p, (uint32_t)code.n) ? code : S(""); }

static void answer(arena *a, const char *mode, int64_t id, int stored, str known, str learning, const char *found_by,
                   cb_http_res *res) {
    wire_deck_languages_found w = {wire_mode_of(mode, (uint32_t)strlen(mode)), id, (uint8_t)stored, amgi_ws(known), amgi_ws(learning),
                                   amgi_ws(str_c(found_by))};
    amgi_send_wire(a, res, 200, WK_DECK_LANGUAGES_FOUND, &w);
}

void amgi_deck_languages_detect(arena *a, const amgi_ops *o, const char *mode, double deck_id, cb_http_res *res) {
    col_deck *decks;
    size_t nd;
    col_err e = {0};
    if (ops_list_decks(a, o, &decks, &nd, &e)) return amgi_send_text(res, 500, e.message);
    const col_deck *d = deck_id == deck_id ? amgi_find_deck(decks, nd, (int64_t)deck_id) : NULL;
    if (!d) return amgi_send_message(a, res, 404, S("This deck no longer exists."));
    if (d->known.n) return answer(a, mode, d->id, 1, d->known, d->learning, "stored", res);

    col_page page = {0};
    if (ops_list_notes(a, o, (double)d->id, 0, SAMPLE, &page, &e)) return amgi_send_text(res, 500, e.message);
    col_notetype *nts;
    size_t nnt;
    if (ops_list_notetypes(a, o, &nts, &nnt, &e)) return amgi_send_text(res, 500, e.message);
    str fact = notes_fact(a, o, (double)d->id, nts, nnt);

    str guess_known = S(""), guess_learning = fact;
    if (page.n && amgi_generation_available()) {
        card_sample *sample = ar_alloc(a, (page.n + 1) * sizeof *sample);
        size_t ns = 0;
        for (size_t i = 0; i < page.n; i++) {
            const col_notetype *nt = NULL;
            for (size_t k = 0; k < nnt && !nt; k++)
                if (nts[k].id == page.notes[i].notetype_id) nt = &nts[k];
            if (!nt) continue;
            sample[ns++] = (card_sample){nt->name, nt->fields, page.notes[i].fields, nt->nfields < page.notes[i].nfields ? nt->nfields : page.notes[i].nfields};
        }
        card_deck_guess g;
        gem_err ge = {0};
        if (card_detect_deck_languages(a, d->name, sample, ns, fact, &g, &ge)) {
            CB_WARN("gemini", "the languages of deck %lld were not read: %.*s", (long long)d->id, (int)ge.message.n, ge.message.p);
        } else {
            str k = known_code(g.known), l = known_code(g.learning);
            if (!fact.n) guess_learning = l;
            guess_known = k;
            int both = k.n && l.n && !str_eq(k, l);
            if (g.high && both && (!fact.n || str_eq(l, fact))) {
                col_deck_languages r;
                if (ops_set_deck_languages(a, o, (double)d->id, k, l, &r, &e))
                    return amgi_send_message(a, res, e.status == 404 ? 404 : 400, e.status == 404 ? S("This deck no longer exists.") : e.message);
                /* found_by: "notes" when the notes' fact decided learning (Gemini only supplied known), "gemini" when it decided both */
                return answer(a, mode, r.id, 1, r.known, r.learning, fact.n ? "notes" : "gemini", res);
            }
        }
    }
    if (str_eq(guess_known, guess_learning)) guess_known = S(""); /* one language is not a pair: no guess for known */
    answer(a, mode, d->id, 0, guess_known, guess_learning, "", res);
}
