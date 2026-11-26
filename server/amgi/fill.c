/* Fill missing audio: the notes of a deck that do not yet carry the clip of their text, and the making of one note's clip.
 *
 * POST /decks/:id/audio-plan reads the deck's notes and says which need a clip (and changes nothing), and POST /notes/:id/audio-fill
 * records the clip of one note and writes its reference into the audio field. Both are given what to read aloud into what (a
 * note type's two fields by index, the reference form) and whose language it is (the deck's stored pair, its learning or known
 * side). For the amgi Listening note type, side "both" is the two sides at once: Target into TargetAudio in the learning language,
 * Cue into CueAudio in the known one, always as <audio> elements, which is what that note type's card sequences.
 *
 * What a clip is is the one rule of POST /audio (gen.c): named by the content of its text and language, reused when it is in the
 * media folder, else recorded and added. A note is up to date when its audio field holds exactly one clip of amgi's (text.c says
 * which are), the clip of its current text (the same 20-hex hash: a starter clip is an mp3 where a recorded one is a wav, and
 * both are that text spoken), in the form asked for, and the file is there. Another add-on's [sound:] or an image in the field is
 * never touched; only amgi's own reference is replaced.
 *
 * It was the Anki add-on's "Fill missing audio" (core.py plan_fill and apply_fill), which needed Node to make the clips. */
#include <string.h>

#include "amgi.h"
#include "messages.h"

#define SIDE_LEARNING 0
#define SIDE_KNOWN 1
#define SIDE_BOTH 2

/* One text and the field its clip goes in, spoken in a language. */
typedef struct { int text_field, audio_field; str language; } fill_job;
/* What a request asks: one job, or the Listening note type's two. html: the reference is an <audio> element, else [sound:]. */
typedef struct {
    int64_t notetype_id;
    fill_job jobs[2];
    int njobs, html;
} fill_cfg;

/* What a note needs of one job. */
typedef enum { JOB_SKIPPED, JOB_UP_TO_DATE, JOB_NEEDS } job_state;
typedef struct { job_state state; str text, wanted; } job_check;

static str deck_gone(void) { return S("This deck no longer exists."); }

static const col_notetype *notetype_by_id(const col_notetype *nts, size_t n, int64_t id) {
    for (size_t i = 0; i < n; i++)
        if (nts[i].id == id) return &nts[i];
    return NULL;
}

/* The request as a config: 0, or -1 having answered. Nothing is read of the collection but the deck's pair and the note types. */
static int configure(arena *a, const amgi_ops *o, const char *mode, const wire_q_fill *q, double deck_id, fill_cfg *cfg,
                     cb_http_res *res) {
    (void)mode;
    col_deck *decks;
    size_t nd;
    col_err e = {0};
    if (ops_list_decks(a, o, &decks, &nd, &e)) return amgi_send_text(res, 500, e.message), -1;
    const col_deck *d = deck_id == deck_id ? amgi_find_deck(decks, nd, (int64_t)deck_id) : NULL;
    if (!d) return amgi_send_message(a, res, 404, deck_gone()), -1;
    if (!d->known.n) return amgi_send_message(a, res, 409, amgi_no_languages_refusal()), -1;

    str side_name = amgi_str(q->side), form = amgi_str(q->form);
    int side = str_eq_c(side_name, "learning") ? SIDE_LEARNING : str_eq_c(side_name, "known") ? SIDE_KNOWN
               : str_eq_c(side_name, "both") ? SIDE_BOTH : -1;
    if (side < 0) return amgi_send_message(a, res, 400, S("side must be learning, known or both")), -1;
    if (side != SIDE_BOTH && !str_eq_c(form, "sound") && !str_eq_c(form, "html"))
        return amgi_send_message(a, res, 400, S("form must be sound or html")), -1;

    col_notetype *nts;
    size_t nnt;
    if (ops_list_notetypes(a, o, &nts, &nnt, &e)) return amgi_send_text(res, 500, e.message), -1;
    const col_notetype *nt = notetype_by_id(nts, nnt, q->notetype_id);
    if (!nt) return amgi_send_message(a, res, 404, S("This note type no longer exists.")), -1;
    *cfg = (fill_cfg){.notetype_id = nt->id};
    if (side == SIDE_BOTH) {
        amgi_fields idx = amgi_field_indexes(a, nt);
        if (!str_eq_c(nt->name, AMGI_NOTETYPE_NAME) || idx.cue < 0 || idx.target < 0 || idx.cue_audio < 0 || idx.target_audio < 0)
            return amgi_send_message(a, res, 400, S("side both is for the \"" AMGI_NOTETYPE_NAME "\" note type, with its Cue, Target, "
                                                  "CueAudio and TargetAudio fields")), -1;
        cfg->jobs[0] = (fill_job){idx.target, idx.target_audio, d->learning};
        cfg->jobs[1] = (fill_job){idx.cue, idx.cue_audio, d->known};
        cfg->njobs = 2;
        cfg->html = 1;
        return 0;
    }
    if (q->text_field < 0 || q->audio_field < 0 || (size_t)q->text_field >= nt->nfields || (size_t)q->audio_field >= nt->nfields)
        return amgi_send_message(a, res, 400, S("textField and audioField must be fields of the note type")), -1;
    if (q->text_field == q->audio_field)
        return amgi_send_message(a, res, 400, S("textField and audioField must be different fields")), -1;
    cfg->jobs[0] = (fill_job){q->text_field, q->audio_field, side == SIDE_LEARNING ? d->learning : d->known};
    cfg->njobs = 1;
    cfg->html = str_eq_c(form, "html");
    return 0;
}

/* The clip's name without its extension and without Anki's clash suffix: its prefix and 20 hex of hash. */
static str clip_stem(str name) {
    size_t n = strlen(AMGI_MEDIA_PREFIX) + 20;
    return name.n >= n ? str_sub(name, 0, n) : name;
}

/* What job j needs of note n. -1 with e when the media folder could not be asked. */
static int check_job(arena *a, const amgi_ops *o, const fill_cfg *cfg, const fill_job *j, const col_note *n, job_check *out,
                     col_err *e) {
    *out = (job_check){JOB_SKIPPED, S(""), S("")};
    if ((size_t)j->text_field >= n->nfields || (size_t)j->audio_field >= n->nfields) return 0;
    str text = col_spoken_text(a, n->fields[j->text_field]);
    if (!text.n) return 0;
    out->text = text;
    out->wanted = amgi_media_name(a, text, j->language, "wav");
    out->state = JOB_NEEDS;
    col_audio_ref *refs;
    size_t nrefs = col_audio_references(a, n->fields[j->audio_field], &refs);
    const col_audio_ref *owned = NULL;
    size_t nowned = 0, nforeign = 0;
    for (size_t i = 0; i < nrefs; i++) {
        if (col_is_owned_media_name(refs[i].name)) owned = &refs[i], nowned++;
        else nforeign++;
    }
    /* Missing audio means no audio at all: someone else's clip (another add-on's, the deck author's) is audio, so the note is left as
     * it is, in the plan and in the fill's own re-check alike (both come here). Only amgi's own clips are refilled, by the rule below. */
    if (nforeign) {
        out->state = JOB_UP_TO_DATE;
        return 0;
    }
    if (nowned != 1 || owned->html != cfg->html || !str_eq(clip_stem(owned->name), clip_stem(out->wanted))) return 0;
    int has;
    if (ops_has_media(a, o, owned->name, &has, e)) return -1;
    if (has) out->state = JOB_UP_TO_DATE;
    return 0;
}

/* A note's state: it needs a clip when any of its jobs does; is up to date when it has a job and none needs one; else skipped.
 * 0, or -1 with e when the media folder could not be asked. */
static int check_note(arena *a, const amgi_ops *o, const fill_cfg *cfg, const col_note *n, job_check *checks, job_state *state,
                      col_err *e) {
    *state = JOB_SKIPPED;
    for (int k = 0; k < cfg->njobs; k++) {
        if (check_job(a, o, cfg, &cfg->jobs[k], n, &checks[k], e)) return -1;
        if (checks[k].state == JOB_NEEDS) *state = JOB_NEEDS;
        else if (checks[k].state == JOB_UP_TO_DATE && *state == JOB_SKIPPED) *state = JOB_UP_TO_DATE;
    }
    return 0;
}

void amgi_fill_plan(arena *a, const amgi_ops *o, const char *mode, double deck_id, const wire_q_fill *q, cb_http_res *res) {
    fill_cfg cfg;
    if (configure(a, o, mode, q, deck_id, &cfg, res)) return;
    /* The deck's notes and its subdecks', a page at a time: both transports list each note once, in ascending id, which is the order
     * of to_fill. */
    wire_fill_plan w = {wire_mode_of(mode, (uint32_t)strlen(mode)), NULL, 0, 0, 0};
    size_t cap = 0;
    col_err e = {0};
    for (double offset = 0;;) {
        col_page page;
        if (ops_list_notes(a, o, deck_id, offset, 200, &page, &e)) return amgi_send_text(res, 500, e.message);
        for (size_t i = 0; i < page.n; i++) {
            const col_note *n = &page.notes[i];
            if (n->notetype_id != cfg.notetype_id) {
                w.skipped++;
                continue;
            }
            job_check checks[2];
            job_state s;
            if (check_note(a, o, &cfg, n, checks, &s, &e)) return amgi_send_text(res, 500, e.message);
            if (s == JOB_NEEDS) {
                if (w.nto_fill == cap) {
                    wire_fill_note *grown = ar_alloc(a, (cap = cap ? cap * 2 : 256) * sizeof *grown);
                    if (w.nto_fill) memcpy(grown, w.to_fill, w.nto_fill * sizeof *grown);
                    w.to_fill = grown;
                }
                w.to_fill[w.nto_fill++].id = n->id;
            } else if (s == JOB_UP_TO_DATE) {
                w.up_to_date++;
            } else {
                w.skipped++;
            }
        }
        if (!page.has_more || !page.n) break;
        offset += (double)page.n;
    }
    if (!w.to_fill) w.to_fill = ar_alloc(a, sizeof *w.to_fill);
    amgi_send_wire(a, res, 200, WK_FILL_PLAN, &w);
}

void amgi_fill_note(arena *a, const amgi_ops *o, const char *mode, double note_id, const wire_q_fill *q, cb_http_res *res) {
    fill_cfg cfg;
    if (configure(a, o, mode, q, (double)q->deck_id, &cfg, res)) return;
    col_note n;
    col_err e = {0};
    if (ops_get_note(a, o, note_id, &n, &e)) return e.status == 404 ? amgi_send_message(a, res, 404, e.message) : amgi_send_text(res, 500, e.message);
    if (n.notetype_id != cfg.notetype_id)
        return amgi_send_message(a, res, 400, S("This note is not of the note type the fill was asked for."));
    wire_note_changed done = {wire_mode_of(mode, (uint32_t)strlen(mode)), n.id, {"", 0}};
    /* Asked again at the last moment: a note that has its clip by now (another fill, Anki's own editor) is answered as done, and
     * Gemini is not asked. */
    job_check checks[2];
    job_state s;
    if (check_note(a, o, &cfg, &n, checks, &s, &e)) return amgi_send_text(res, 500, e.message);
    if (s != JOB_NEEDS) return amgi_send_wire(a, res, 200, WK_NOTE_CHANGED, &done);
    if (amgi_admission_refused(a, res)) return;
    str *fields = ar_alloc(a, (n.nfields + 1) * sizeof(str));
    for (size_t i = 0; i < n.nfields; i++) fields[i] = n.fields[i];
    for (int k = 0; k < cfg.njobs; k++) {
        if (checks[k].state != JOB_NEEDS) continue;
        amgi_clip clip;
        if (amgi_store_clip(a, o, checks[k].text, cfg.jobs[k].language, 0, &clip, res)) return;
        fields[cfg.jobs[k].audio_field] = col_set_owned_audio(a, fields[cfg.jobs[k].audio_field], &clip.filename, cfg.html);
    }
    int has_id, has_warning;
    int64_t id = 0;
    str warning = {0};
    if (ops_update_note(a, o, note_id, fields, n.nfields, 0, S(""), 0, 0, &has_id, &id, &has_warning, &warning, &e))
        return e.status == 404 ? amgi_send_message(a, res, 404, e.message) : amgi_send_message(a, res, 400, e.message);
    amgi_send_wire(a, res, 200, WK_NOTE_CHANGED, &done);
}
