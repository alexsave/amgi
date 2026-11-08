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
cd_id el_id(cd_str tag, cd_str cls);              /* the same, named with a new id (cd_open_id) */
void el_text(cd_str tag, cd_str cls, cd_str s);   /* an element holding one text, closed */
void tmp_text(const char *p, uint32_t len);       /* a one-off text node */
void attr_tmp(cd_str name, const char *p, uint32_t len);
/* A cd_on handler, defined: static, and either argument may go unused. */
#define ON_EVENT(name) \
  static void name(const cd_event_rec *e __attribute__((unused)), void *ctx __attribute__((unused)))
/* A small index carried in a handler's ctx (a row, a slot), and back. */
#define CTX_OF(i) ((void *)(uintptr_t)(i))
#define CTX_INDEX(ctx) ((uint32_t)(uintptr_t)(ctx))
/* An event is a cd_on handler's: the listening and tagging it replaced, and the catch-all hook, are
 * poisoned, so a direct use of any of them does not compile. */
#pragma GCC poison cd_listen cd_listen_window cd_tag_set cd_tag cd_on_event
/* heroicons 24/outline as @heroicons/react renders them: one or two paths, an optional style. */
void icon(const char *d1, const char *d2, cd_str style);
void icon_with(const char *d1, const char *d2, cd_str style, cd_str cls); /* with a class (className="icon") */
extern const char ICON_COG[], ICON_COG_HUB[], ICON_PLUS[], ICON_TRASH[], ICON_X[];

/* A timer is cd_timer_cb's callback, stopped with cd_timer_stop: the raw token form and its hook
 * are poisoned, so a direct use of either does not compile. */
#pragma GCC poison cd_timer_start cd_on_timer

/* ---- requests (net.c) ---- */
/* The answer a request brings: the HTTP status and the message, read into the kind's struct the
 * caller passed (out). ok: a 2xx of the expected kind. err: the error answer, when one came. */
typedef struct { uint32_t status; int ok; wire_error err; } answer;
/* Ask: method and path under /api/anki; the body a request struct of kind qkind (WIRE_NONE: no
 * body). The answer comes to fn(ctx, status, bytes, len) (cd_http_cb). */
void ask(cd_http_fn fn, void *ctx, const char *method, const char *path, uint32_t qkind, const void *body);
/* The same with other settings than the saved ones (a scan of a folder typed but not saved). */
void ask_as(const text *with, cd_http_fn fn, void *ctx, const char *method, const char *path, uint32_t qkind,
            const void *body);
/* An answer's handler, defined: static, and ctx may go unused. */
#define ON_ANSWER(name) \
  static void name(void *ctx __attribute__((unused)), uint32_t status, const uint8_t *p, uint32_t len)
/* Inside an answer's handler: read the bytes as kind into out, its lists in held room that lives
 * until the next take into the same holder (so a page of notes can stay on screen). */
typedef struct { uint8_t *bytes; void *mem; } holder;
answer take(holder *h, uint32_t kind, uint32_t status, const uint8_t *p, uint32_t len, void *out);
void holder_free(holder *h);
/* A clip's own bytes (GET /media/<name>), to fn(ctx, ...). */
void ask_media(cd_http_fn fn, void *ctx, const char *name, uint32_t len);
/* The token form and its hook are poisoned: a request's answer is its callback's. */
#pragma GCC poison cd_http cd_on_http
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
void decks_drop_tree(int64_t id);  /* a deck that was deleted, and its subdecks, out of the list now */
void poll_status(void);
void state_start(void);   /* the settings are loaded: poll, fetch, and keep polling */
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
void go_replace(const char *path, uint32_t len); /* as go, in place of the current history entry */
void page_show(void);                     /* the screen for route, built again */
cd_id page_root(void);                    /* the screen's root element, or 0 */

/* ---- the screens and parts: each module's hooks ---- */
void decks_build(void);                   /* DeckList, under page.root */
void decks_rows(void);                    /* its rows, when decks change */
int decks_setup_wanted(void);             /* the setup screen is what the state calls for */
int decks_setup_shown(void);              /* the setup screen is what is on screen */
void decks_forget(void);

void settings_build(void);
void settings_after(void);                /* after the page region closed */
void settings_forget(void);

void deck_build(void);                    /* CardList, for route_deck */
void deck_after(void);
void deck_forget(void);
void deck_reload(void);                   /* the open page of notes, asked again */
void deck_decks_changed(void);            /* the deck list changed (a rename, a count) */
void deck_notetypes_known(void);
void deck_gone_build(void);               /* the page of a deck that is not there (any more) */

/* AudioChip: a chip is a button; chips are kept in a table by id so one plays at a time. */
typedef struct { cd_id node; text filename; uint32_t tone; } chip_spec;
enum { TONE_CUE, TONE_TARGET };
/* Builds a chip (nothing when filename is empty) and returns its slot, or -1. */
int32_t chip_build(const char *filename, uint32_t flen, const char *label, uint32_t tone);
void chip_forget(int32_t slot);           /* its node went with a region */
cd_id chip_node(int32_t slot);
void chips_audio_loaded(uint32_t token, uint32_t clip);
void chips_audio_ended(uint32_t voice);

void form_build(int64_t deck_id, const lang_pair *langs); /* CardForm */
void form_forget(void);
void form_notetypes_known(void);
void form_langs_changed(const lang_pair *langs);

/* BulkRun (bulk.c): a run of lines into cards, built at the end of the form's box. */
void bulk_start(cd_id form_box, int64_t deck, const notetype *type, const lang_pair *langs, const wire_str *lines,
                uint32_t n, void (*on_finished)(void));
void bulk_forget(void);

/* FirstRun (firstrun.c), shown as all of parent's children. */
void firstrun_show(cd_id parent);
void firstrun_forget(void);

/* CardPanel (panel.c), in the open row of the deck page. */
void panel_build(int64_t id, const wire_strs *fields, const text *names, uint32_t nnames, const lang_pair *langs);
void panel_after(void);
void panel_forget(void);
void deck_note_removed(int64_t id);       /* the panel deleted its note */

/* StarterDeck (starter.c), last in parent; TemplateUpdate (template.c), first in .app-content. */
void starter_show(cd_id parent);
void starter_forget(void);
void template_mode_changed(void);

/* A confirmation in the page (modal.c), in place of window.confirm. */
void confirm_ask(const char *title, const char *body, uint32_t blen, const char *note, const char *yes,
                 void (*then)(void *), void *ctx);
void confirm_close(void);

/* After the next decks answer, open deck id (a deck just made: the list must know it first). */
void open_after_refresh(int64_t id);

/* Store tokens: the caller's id in the top byte, which cd_on_store (shell.c) routes by, and cdom keeps
 * every token from CD_TOKEN_CDOM (0x80000000) up for itself: so no caller id may reach 0x80. */
enum { STORE_SETTINGS = 1, STORE_DECK_LANGS, STORE_CALLERS /* one past the last */ };
_Static_assert(STORE_CALLERS <= 0x80, "a store caller id past 0x7f makes tokens in cdom's own range");
#define STORE_TOKEN(caller, n) ((uint32_t)(caller) << 24 | (uint32_t)(n))
#endif
