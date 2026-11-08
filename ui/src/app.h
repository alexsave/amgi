/* amgi's UI in C on cdom: what the modules share. The DOM each module builds is the React app's
 * own (src/components), element for element and class for class, so the same stylesheet draws the
 * same page. State lives in C (state.c holds what DeckContext held); every /api/anki answer and
 * request body crosses in amgi's wire format (ui/wire/wire.h). */
#ifndef AMGI_APP_H
#define AMGI_APP_H
#include "cdom.h"
#include "cdom_audio.h"
#include "cdom_net.h"
#include "cdom_store.h"
#include "cdom_url.h"
#include "../wire/wire.h"

/* ---- text (text.c) ---- */
uint32_t zlen(const char *s);
int same(const char *a, uint32_t alen, const char *b, uint32_t blen);
int same_z(const char *a, uint32_t alen, const char *z);       /* against a C string */
int same_ascii_nocase(const char *a, uint32_t alen, const char *z); /* ASCII letters folded */
/* An owned copy of some bytes, zero-terminated (text_set frees what it held). */
typedef struct { char *p; uint32_t len; } text;
void text_set(text *t, const char *p, uint32_t len);
void text_setz(text *t, const char *z);
void text_free(text *t);
uint32_t id_dec(char *dst, int64_t id);        /* a positive id in decimal (at most 20 bytes) */
int64_t dec_id(const char *s, uint32_t len);    /* -1 for anything but digits */
/* JS's String.prototype.trim: the Unicode White_Space and line terminators at both ends. */
wire_str trim(wire_str s);
/* Markup taken out for a preview: every <...> becomes a space, &nbsp; a space, runs of white space
 * one space, the ends trimmed (src/utils/ankiFields.js stripHtmlForPreview). dst needs s.len bytes. */
uint32_t strip_html(char *dst, wire_str s);
/* The tags taken out, nothing else (CardList's textIn): dst needs s.len bytes; the result trimmed. */
uint32_t strip_tags(char *dst, wire_str s);
/* The src of the first <audio ... src="..."> in a field, or an empty string. */
wire_str audio_src(wire_str field);
/* A field holds a sound reference: [sound:...] or an <audio ... src=. */
int has_audio_ref(wire_str field);
/* lyricsParse.js's normalizeForDedupe into dst (s.len bytes): white space trimmed and collapsed,
 * the trailing run of white space and punctuation dropped (unless that is all there is). */
uint32_t dedupe_key(char *dst, wire_str s);
/* lyricsParse.js's parseLyricsPaste: the lines a paste makes cards of (see text.c). */
uint32_t paste_lines(const char *s, uint32_t len, wire_str *out, uint32_t cap, char *keys);

/* ---- the DOM, shorthand (dom.c) ---- */
void el(cd_str tag, cd_str cls);                  /* cd_open, then class when cls */
void el_text(cd_str tag, cd_str cls, cd_str s);   /* an element holding one text, closed */
void tmp_text(const char *p, uint32_t len);       /* a one-off text node */
void attr_tmp(cd_str name, const char *p, uint32_t len);
void listen_click(uint32_t tag);                  /* the last node listens for clicks as tag */
cd_id listen_as(uint32_t ev, uint32_t tag);       /* the last node listens for ev as tag; its id */
/* heroicons 24/outline as @heroicons/react renders them: one or two paths, an optional style. */
void icon(const char *d1, const char *d2, cd_str style);
void icon_with(const char *d1, const char *d2, cd_str style, cd_str cls); /* with a class (className="icon") */
extern const char ICON_COG[], ICON_COG_HUB[], ICON_PLUS[], ICON_TRASH[], ICON_X[];

/* ---- event tags: a module's id in the top byte, its own action and index below ---- */
enum { M_SHELL = 1, M_DECKS, M_SETTINGS, M_DECK, M_CHIP, M_FORM, M_PANEL, M_BULK, M_MODAL, M_FIRSTRUN, M_STARTER,
       M_TEMPLATE };
#define TAG(module, action, index) ((uint32_t)(module) << 24 | (uint32_t)(action) << 16 | (uint32_t)(index))
#define TAG_MODULE(t) ((t) >> 24)
#define TAG_ACTION(t) (((t) >> 16) & 0xff)
#define TAG_INDEX(t) ((t) & 0xffff)
/* A timer: cd_on_timer(module << 24 | token) after ms, which shell.c hands to that module. The only
 * way to start one, so no timer can go out without the module that is waiting for it: cdom's own
 * call is poisoned below, and a direct use of it does not compile. */
static inline void timer_start(uint32_t module, uint32_t ms, uint32_t token) {
  cd_timer_start(ms, module << 24 | (token & 0xffffff));
}
#pragma GCC poison cd_timer_start

/* ---- requests (net.c) ---- */
/* The answer a request brings: the HTTP status and the message, read into the kind's struct the
 * caller passed (out). ok: a 2xx of the expected kind. err: the error answer, when one came. */
typedef struct { uint32_t status; int ok; wire_error err; } answer;
/* Ask: method and path under /api/anki; the body a request struct of kind qkind (WIRE_NONE: no
 * body). The answer comes to the module's on_answer hook with the token as given. */
void ask(uint32_t module, uint32_t token, const char *method, const char *path, uint32_t qkind, const void *body);
/* The same with other settings than the saved ones (a scan of a folder typed but not saved). */
void ask_as(const text *with, uint32_t module, uint32_t token, const char *method, const char *path, uint32_t qkind,
            const void *body);
/* Inside an on_answer hook: read the bytes as kind into out, its lists in held room that lives until
 * the next take into the same holder (so a page of notes can stay on screen). */
typedef struct { uint8_t *bytes; void *mem; } holder;
answer take(holder *h, uint32_t kind, uint32_t status, const uint8_t *p, uint32_t len, void *out);
void holder_free(holder *h);
/* A clip's own bytes (GET /media/<name>), to cd_on_http as module M_CHIP. */
void ask_media(uint32_t token, const char *name, uint32_t len);
/* The answer's failure as a sentence (the server's error, or what went wrong on the way). */
uint32_t answer_message(const answer *a, char *dst, uint32_t cap);

/* ---- the settings (settings.c) ---- */
enum { S_BASE_DIR, S_COLLECTION, S_PROFILE, S_BRIDGE_URL, S_BRIDGE_TOKEN, S_FIELDS };
extern text settings[S_FIELDS];
extern int settings_stored, settings_loaded;
/* The settings as the five header lines the server reads (src/server/anki/settings.js), of s (0:
 * the saved ones): into dst, room settings_room(s); returns the bytes. */
uint32_t settings_block(char *dst, const text *s);
uint32_t settings_room(const text *s);
void settings_save(void);                 /* settings[] into the store */
void settings_load(void);                 /* from the store; settings_loaded once it answers */
void settings_got(const uint8_t *p, int32_t len);
void deck_langs_got(uint32_t token, const uint8_t *p, int32_t len);

/* ---- the state DeckContext held (state.c) ---- */
typedef struct { int64_t id; cd_str name; uint32_t count; } deck;
extern deck *decks;
extern uint32_t ndecks;
extern int decks_known;         /* a decks answer has come */
extern uint32_t mode;           /* WIRE_MODE_* */
extern int installed;           /* -1 unknown, 0 no, 1 yes */
int ready(void);                /* direct or bridge */
const deck *deck_by_id(int64_t id);
void refresh_decks(void);
void poll_status(void);
void state_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void state_start(void);   /* the settings are loaded: poll, fetch, and keep polling */
void state_timer(uint32_t token);
/* The note types, asked once (ensure) and kept: id, name, field names. */
typedef struct { int64_t id; text name; text *fields; uint32_t nfields, sort_field; } notetype;
extern notetype *notetypes;
extern uint32_t nnotetypes;
extern int notetypes_known;
void ensure_notetypes(void);
const notetype *notetype_by_id(int64_t id);
const notetype *amgi_notetype(void);     /* "amgi Listening", or 0 */
/* Where each amgi field sits on a note type (-1 absent), by name, case folded (amgiNotetype.js). */
typedef struct { int32_t cue, cue_audio, target, target_audio, language, notes; } amgi_fields;
amgi_fields amgi_fields_of(const text *names, uint32_t n);
extern const char *const AMGI_FIELD_NAMES[6]; /* in that order: Cue, CueAudio, Target, TargetAudio, Language, Notes */
/* ankiFields.js's guessFields: which field is the text to read and which holds its audio, on any
 * note type (-1: none). sort_field is the note type's sort field, or WIRE_NONE. */
typedef struct { int32_t text, audio, cue_audio; } field_guess;
field_guess guess_fields(const text *names, uint32_t n, uint32_t sort_field);
#define AMGI_NOTETYPE_NAME "amgi Listening"

/* The badge (AnkiModeBadge), wherever it is built. */
typedef struct { const char *label, *color, *title; } presentation;
const presentation *present(uint32_t mode);
typedef struct { cd_id span, dot, label; } badge;
void badge_build(badge *b);
void badges_update(void);
extern badge badges[2];

/* ---- languages (lang.c): src/constants/languages.js ---- */
typedef struct { const char *code, *name, *flag; } language;
extern const language LANGUAGES[];
extern const uint32_t NLANGUAGES;
const char *language_name(const char *code, uint32_t len); /* the code itself when unknown */
/* A deck's pair, remembered per deck in the store ("amgi:deck-languages:<id>": "known learning"). */
typedef struct { char known[8], learning[8]; } lang_pair;
void deck_langs_load(int64_t deck_id);   /* answers through deck_langs_loaded */
void deck_langs_save(int64_t deck_id, const lang_pair *p);
void deck_langs_loaded(int64_t deck_id, const lang_pair *p);

/* ---- routing (shell.c) ---- */
enum { R_DECKS, R_SETTINGS, R_DECK };
extern uint32_t route;
extern int64_t route_deck;
extern cd_id app_content;
void go(const char *path, uint32_t len);
void go_deck(int64_t id);
void page_show(void);                     /* the screen for route, built again */
cd_id page_root(void);                    /* the screen's root element, or 0 */

/* ---- the screens and parts: each module's hooks ---- */
void decks_build(void);                   /* DeckList, under page.root */
void decks_rows(void);                    /* its rows, when decks change */
int decks_setup_wanted(void);             /* the setup screen is what the state calls for */
int decks_setup_shown(void);              /* the setup screen is what is on screen */
void decks_forget(void);
void decks_click(uint32_t tag);
void decks_event(const cd_event_rec *e, uint32_t tag);
void decks_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);

void settings_build(void);
void settings_after(void);                /* after the page region closed */
void settings_forget(void);
void settings_event(const cd_event_rec *e, uint32_t tag);
void settings_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void settings_timer(uint32_t token);

void deck_build(void);                    /* CardList, for route_deck */
void deck_after(void);
void deck_forget(void);
void deck_event(const cd_event_rec *e, uint32_t tag);
void deck_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void deck_reload(void);                   /* the open page of notes, asked again */
void deck_decks_changed(void);            /* the deck list changed (a rename, a count) */
void deck_notetypes_known(void);

/* AudioChip: a chip is a button; chips are kept in a table by id so one plays at a time. */
typedef struct { cd_id node; text filename; uint32_t tone; } chip_spec;
enum { TONE_CUE, TONE_TARGET };
/* Builds a chip (nothing when filename is empty) and returns its slot, or -1. */
int32_t chip_build(const char *filename, uint32_t flen, const char *label, uint32_t tone);
void chip_forget(int32_t slot);           /* its node went with a region */
cd_id chip_node(int32_t slot);
void chip_event(uint32_t tag);
void chip_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void chips_audio_loaded(uint32_t token, uint32_t clip);
void chips_audio_ended(uint32_t voice);

void form_build(int64_t deck_id, const lang_pair *langs); /* CardForm */
void form_forget(void);
void form_event(const cd_event_rec *e, uint32_t tag);
void form_notetypes_known(void);
void form_langs_changed(const lang_pair *langs);

/* BulkRun (bulk.c): a run of lines into cards, built at the end of the form's box. */
void bulk_start(cd_id form_box, int64_t deck, const notetype *type, const lang_pair *langs, const wire_str *lines,
                uint32_t n, void (*on_finished)(void));
void bulk_forget(void);
void bulk_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void bulk_timer(uint32_t token);
void bulk_event(const cd_event_rec *e, uint32_t tag);

/* FirstRun (firstrun.c), shown as all of parent's children. */
void firstrun_show(cd_id parent);
void firstrun_forget(void);
void firstrun_event(uint32_t tag);
void firstrun_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);

/* CardPanel (panel.c), in the open row of the deck page. */
void panel_build(int64_t id, const wire_strs *fields, const text *names, uint32_t nnames, const lang_pair *langs);
void panel_after(void);
void panel_forget(void);
void panel_event(const cd_event_rec *e, uint32_t tag);
void panel_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void deck_note_removed(int64_t id);       /* the panel deleted its note */

/* StarterDeck (starter.c), last in parent; TemplateUpdate (template.c), first in .app-content. */
void starter_show(cd_id parent);
void starter_forget(void);
void starter_event(uint32_t tag);
void starter_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);
void template_mode_changed(void);
void template_event(uint32_t tag);
void template_answer(uint32_t token, uint32_t status, const uint8_t *p, uint32_t len);

/* A confirmation in the page (modal.c), in place of window.confirm. */
void confirm_ask(const char *title, const char *body, uint32_t blen, const char *note, const char *yes,
                 void (*then)(void *), void *ctx);
void confirm_close(void);
void modal_event(const cd_event_rec *e, uint32_t tag);

/* After the next decks answer, open deck id (a deck just made: the list must know it first). */
void open_after_refresh(int64_t id);

/* Store tokens: each module's top byte, as event tags. */
#define STORE_TOKEN(module, n) ((uint32_t)(module) << 24 | (uint32_t)(n))
#endif
