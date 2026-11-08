/* src/server/anki/transport.js's resolveTransport in C: on every call, a configured bridge is asked
 * first (1500 ms); an add-on in another protocol is bridge-outdated, one with no profile open
 * bridge-no-collection; a bridge that does not answer falls through to the collection file, whose
 * own status says direct, locked, not-found or unsupported-schema. Nothing is cached between
 * calls. See bridge.h. */
#include "bridge.h"

#include <string.h>

int col_resolve_transport(arena *a, const col_settings *s, col_transport *out, col_err *err) {
  memset(out, 0, sizeof *out);
  if (s->bridge_url.n && s->bridge_token.n) {
    col_bridge b = {s->bridge_url, s->bridge_token};
    col_bridge_status st;
    col_err outdated;
    int probed = col_bridge_probe(a, &b, &st, &outdated);
    if (probed == BRIDGE_OUTDATED) {
      /* Anki is open with an add-on from another amgi: nothing to fall back to, the file is locked. */
      out->mode = "bridge-outdated";
      return 0;
    }
    if (probed == BRIDGE_ANSWERED) {
      out->has_detail = 1;
      out->detail = st;
      if (!st.collection_open) {
        out->mode = "bridge-no-collection";
        return 0;
      }
      out->mode = "bridge";
      out->ops = 1;
      out->bridge = b;
      return 0;
    }
    /* Configured but not answering: the file, as if no bridge were set. */
  }
  if (!s->collection_path.n) {
    out->mode = "unconfigured";
    return 0;
  }
  col_state state;
  if (col_status(a, s->collection_path, &state, err) < 0) {
    /* A DirectError (not ready) reads as its state; anything else is the request's failure. */
    if (err->kind) {
      out->mode = err->kind;
      return 0;
    }
    return -1;
  }
  if (!strcmp(state.status, "ok")) {
    out->mode = "direct";
    out->ops = 1;
    out->has_schema = 1;
    out->schema = state.schema;
  } else {
    out->mode = state.status;
  }
  return 0;
}
