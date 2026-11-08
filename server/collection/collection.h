/* amgi's Anki collection core in C: the port of plusaudio/lib/collection and of the direct
 * transport over it (src/server/anki/directClient.js), for a server that runs it on several
 * threads in one process.
 *
 * One function per directClient op, each taking the collection's path. As in Node, state lives in
 * the process and nowhere else:
 *   - every call on a path runs under that path's lock (directClient's promise chain, keyed by the
 *     path as path.resolve spells it), so two calls of this process never hold the file at once and
 *     "locked" only ever means another process (Anki) has it;
 *   - the backup ledger (backup.js) is per process, keyed the same way: a backup before the first
 *     change of a session, after anybody else changed the file, or past 30 minutes.
 * Each call opens its own connection, does one unit of work and closes it (open.js), so the file
 * is never held between calls.
 *
 * Every result is allocated in the caller's arena. A call answers 0, or -1 with *err set: a
 * collection that is not ready ("locked", "not-found", "unsupported-schema", with the message
 * "collection is <state>"), or an error carrying its message and, where the route answers with
 * one, an HTTP status (404 for a deck that is not there, 400 for the Default deck). The messages
 * are the Node code's, word for word.
 *
 * Ids that arrive from a URL are doubles, as JavaScript's Number() makes them, so a NaN or a
 * fraction behaves (and is named in a message) as it did. */
#ifndef AMGI_COLLECTION_H
#define AMGI_COLLECTION_H
#include <stddef.h>
#include <stdint.h>

#include "util.h"

typedef struct {
  const char *kind; /* "locked", "not-found", "unsupported-schema", or NULL for an error */
  int status;       /* an HTTP status the error carries (404, 400), or 0 */
  str message;
} col_err;

typedef struct { const char *status; int schema; } col_state; /* status "ok" (schema set), "locked", ... */
typedef struct { int64_t id; str name; } col_deck;
typedef struct { int64_t ord; str name, question, answer; } col_template;
typedef struct {
  int64_t id;
  str name;
  int cloze;
  int64_t sort_field;
  str *fields;
  size_t nfields;
  col_template *templates;
  size_t ntemplates;
} col_notetype;
typedef struct { int64_t id, notetype_id; str *fields; size_t nfields; str *tags; size_t ntags; } col_note;
typedef struct { col_note *notes; size_t n; double offset, limit; int has_more; } col_page;

/* A note to add (q_note): language and the learning field index are optional (has_*). */
typedef struct {
  double deck_id, notetype_id;
  str *fields;
  size_t nfields;
  str *tags;
  size_t ntags;
  int has_language;
  str language;
  int has_learning_field;
  double learning_field;
} col_new_note;
typedef struct {
  int ok;     /* addNotesBulk: this note went in; else error says why */
  str error;
  int64_t note_id;
  str guid;
  int64_t *card_ids;
  size_t ncards;
  int has_warning;
  str warning;
} col_added;

typedef struct { int64_t id; str name; int created; } col_deck_made;
typedef struct { int64_t id; str name; int64_t children; } col_renamed;
typedef struct { int64_t id; str name; int64_t subdecks, decks, cards, notes; } col_removal; /* subdecks: summary; decks: removal */

typedef struct { str name, front, back; } col_spec_template;
typedef struct { int64_t ord; str kind; int64_t *fields; size_t nfields; } col_requirement;
typedef struct { str name; const void *data; size_t len; } col_media;
typedef struct {
  str name;
  str *fields;
  size_t nfields;
  col_spec_template *templates;
  size_t ntemplates;
  str css;
  col_requirement *reqs;
  size_t nreqs;
} col_spec;
typedef struct { int created; int has_id; int64_t notetype_id; str reason; } col_notetype_made;

int col_status(arena *a, str path, col_state *out, col_err *err);
int col_list_decks(arena *a, str path, col_deck **out, size_t *n, col_err *err);
int col_list_notetypes(arena *a, str path, col_notetype **out, size_t *n, col_err *err);
int col_list_notes(arena *a, str path, double deck, double offset, double limit, col_page *out, col_err *err);
int col_count_notes(arena *a, str path, double deck, int64_t *out, col_err *err);
int col_field_values(arena *a, str path, double deck, double notetype, double field, str **out, size_t *n, col_err *err);
int col_create_notetype(arena *a, str path, const col_spec *spec, const col_media *media, size_t nmedia,
                        col_notetype_made *out, col_err *err);
int col_create_deck(arena *a, str path, str name, col_deck_made *out, col_err *err);
int col_add_note(arena *a, str path, const col_new_note *note, col_added *out, col_err *err);
int col_add_notes(arena *a, str path, const col_new_note *notes, size_t n, col_added *out, col_err *err);
int col_rename_deck(arena *a, str path, double deck, str name, col_renamed *out, col_err *err);
int col_removal_summary(arena *a, str path, double deck, col_removal *out, col_err *err);
int col_remove_deck(arena *a, str path, double deck, col_removal *out, col_err *err);
int col_remove_note(arena *a, str path, double note, int64_t *note_id, int64_t *cards_removed, col_err *err);
int col_update_note(arena *a, str path, double note, const str *fields, size_t nfields, int has_language, str language,
                    int has_learning_field, double learning_field, int *has_warning, str *warning, col_err *err);
int col_has_media(arena *a, str path, str name, int *out, col_err *err);
int col_read_media(arena *a, str path, str name, int *found, str *bytes, col_err *err);
int col_add_media(arena *a, str path, str name, const void *data, size_t len, str *stored, col_err *err);

/* The collection's media folder: collection.media beside collection.anki2 (media.js). */
str col_media_dir(arena *a, str collection_path);

/* paths.js: the default Anki folder for this platform, and the profiles in a folder (sorted as
 * localeCompare sorts). */
str col_default_base_dir(arena *a);
typedef struct { str name, collection_path; } col_profile;
col_profile *col_list_profiles(arena *a, str base_dir, size_t *n);
#endif
