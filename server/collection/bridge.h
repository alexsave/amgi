/* The Anki bridge client in C: the port of src/server/anki/bridgeClient.js (the add-on's local
 * HTTP server, in amgi's wire format both ways: the b_* answers and the q_* and b_q_media requests
 * of ui/wire/wire.c), and of transport.js's resolveTransport, which picks the bridge or the file on
 * every call.
 *
 * Every request names the protocol (X-Amgi-Bridge-Protocol, WIRE_BRIDGE_PROTOCOL) and carries the
 * token (X-Amgi-Bridge-Token). An answer in another protocol, or in none, is the bridge-outdated
 * mode; a refusal of the token from an add-on too old to name a protocol says nothing of its
 * version. Reads whose cost does not depend on the collection wait 1500 ms; writes, and the reads
 * that scale with a deck, wait 30000 ms, the add-on's own budget (bridgeClient.js says why).
 *
 * Errors are the JavaScript's: a bridge that answered with a failure is the message it gave (or
 * "bridge responded <status>") with that HTTP status; an answer not whole is 502; a bridge that did
 * not answer is "fetch failed", and one that took too long "This operation was aborted", with no
 * status. */
#ifndef AMGI_BRIDGE_H
#define AMGI_BRIDGE_H
#include "collection.h"

typedef struct {
  int profile_open;
  str profile_name;
  int collection_open;
  int has_schema;
  uint32_t schema;
  str anki_version, qt_version;
} col_bridge_status;

typedef struct { str url, token; } col_bridge;

enum { BRIDGE_NONE, BRIDGE_ANSWERED, BRIDGE_OUTDATED };
/* probeBridge: BRIDGE_ANSWERED with *status, BRIDGE_OUTDATED with *outdated (its message), or
 * BRIDGE_NONE when it did not answer (the caller falls back to the file). */
int col_bridge_probe(arena *a, const col_bridge *b, col_bridge_status *status, col_err *outdated);

int col_bridge_list_decks(arena *a, const col_bridge *b, col_deck **out, size_t *n, col_err *err);
int col_bridge_list_notetypes(arena *a, const col_bridge *b, col_notetype **out, size_t *n, col_err *err);
/* The page with the bridge's total (transport.js derives hasMore from it). */
int col_bridge_list_notes(arena *a, const col_bridge *b, double deck, double offset, double limit, col_page *out,
                          int64_t *total, col_err *err);
int col_bridge_count_notes(arena *a, const col_bridge *b, double deck, int64_t *out, col_err *err);
int col_bridge_field_values(arena *a, const col_bridge *b, double deck, double notetype, double field, str **out, size_t *n,
                            col_err *err);
int col_bridge_create_deck(arena *a, const col_bridge *b, str name, col_deck_made *out, col_err *err);
/* addNote: note_id and, when there is one, the warning (no guid or cards: the add-on does not say). */
int col_bridge_add_note(arena *a, const col_bridge *b, const col_new_note *note, col_added *out, col_err *err);
int col_bridge_add_notes(arena *a, const col_bridge *b, const col_new_note *notes, size_t n, col_added *out, size_t *nout,
                         col_err *err);
int col_bridge_update_note(arena *a, const col_bridge *b, double note, const str *fields, size_t nfields, int has_language,
                           str language, int has_learning_field, double learning_field, int64_t *note_id, int *has_warning,
                           str *warning, col_err *err);
int col_bridge_has_media(arena *a, const col_bridge *b, str name, int *out, col_err *err);
int col_bridge_rename_deck(arena *a, const col_bridge *b, double deck, str name, col_deck *out, col_err *err);
int col_bridge_removal_summary(arena *a, const col_bridge *b, double deck, col_removal *out, col_err *err);
int col_bridge_remove_deck(arena *a, const col_bridge *b, double deck, col_removal *out, col_err *err);
int col_bridge_remove_note(arena *a, const col_bridge *b, double note, int64_t *note_id, int64_t *cards_removed, col_err *err);
int col_bridge_read_media(arena *a, const col_bridge *b, str name, int *found, str *bytes, col_err *err);
int col_bridge_add_media(arena *a, const col_bridge *b, str name, const void *data, size_t len, str *stored, col_err *err);

/* ---- transport.js: which transport answers, right now ---- */
typedef struct { str collection_path, bridge_url, bridge_token; } col_settings;
typedef struct {
  const char *mode; /* direct, bridge, locked, not-found, unsupported-schema, unconfigured, bridge-no-collection, bridge-outdated */
  int has_schema;
  int schema;              /* direct: the collection's schema */
  int has_detail;          /* bridge and bridge-no-collection: the bridge's status */
  col_bridge_status detail;
  int ops;                 /* 1 when mode is direct or bridge: there is a transport to call */
  col_bridge bridge;       /* mode bridge: where */
} col_transport;
/* resolveTransport: 0 with *out, or -1 when the collection's own status threw (a file that is not
 * a database, say), which the route answers as a failure of the request. */
int col_resolve_transport(arena *a, const col_settings *s, col_transport *out, col_err *err);
#endif
