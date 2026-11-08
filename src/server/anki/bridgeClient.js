// Talking to a running anki/addon/amgi_bridge over localhost HTTP - the
// "Anki open" transport. See that add-on's README, "Local HTTP bridge", for
// the endpoint contract this mirrors and the auth model this relies on.
//
// This client only ever runs on amgi's own server (see transport.js's
// module comment), so the `fetch()` calls here never carry a browser
// `Origin` header at all - and bridge_auth.py treats "no Origin" as not an
// origin failure by design (a same-machine CLI caller, which this is). The
// shared-secret token is therefore the only credential these requests need.
//
// Every body, both ways, is in amgi's wire format: the b_* kinds and the request kinds in
// ui/wire/wire.c's table, written and read through ui/server/wire.mjs (the add-on reads the same
// table, generated into its wire_schema.py). This file only names, per call, which kind goes and
// which comes back. Every request carries the protocol version; an answer in another one (or with
// none: an add-on old enough to speak JSON) is a BridgeOutdatedError, which transport.js reports
// as the bridge-outdated mode: press Install into Anki again, then restart Anki.

import { BRIDGE_PROTOCOL, WIRE_MIME, decode, encode } from '../../../ui/server/wire.mjs';

export const PROTOCOL_HEADER = 'X-Amgi-Bridge-Protocol';
// The short timeout is for "is a bridge there, and is it answering": the
// probe below, and the fixed-size reads whose cost does not depend on the
// collection. Failing those fast is the point - the caller falls back to the
// direct transport rather than making the page wait.
const DEFAULT_TIMEOUT_MS = 1500;

// Anything that puts real work on Anki's main thread gets the add-on's own
// budget instead.
//
// bridge_dispatch.DEFAULT_TIMEOUT_SECONDS is 30: that is how long the add-on
// itself waits for an operation to come back from Anki's operation queue,
// and a write waits there behind whatever Anki was already doing before its
// own inserts even start. 1500ms on this side made the two ends disagree
// about how long an operation is allowed to take, and the disagreement is
// worse than a slow call, because aborting the `fetch` does not cancel the
// CollectionOp: the add-on carries on and commits the notes while this
// client reports the write as failed. The row says "failed", the note is in
// the deck, and adding it again is the obvious next thing for the person to
// do - a duplicate produced by the timeout itself.
//
// A single-note write rarely came near 1500ms, which is why this held up
// until now. A batched write from the bulk-add screen (see BulkRun.js) is
// one operation doing up to ten inserts, behind an Anki that may be mid-sync
// or showing a dialog, and has every reason to. The same applies to the one
// read whose cost scales with the deck rather than with the request.
const OPERATION_TIMEOUT_MS = 30000;

export class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

/** The add-on answered in another bridge protocol than this server speaks. */
export class BridgeOutdatedError extends BridgeError {
  constructor(theirs) {
    super(`the amgi add-on in Anki speaks bridge protocol ${theirs || 'none (it predates them)'}, this amgi ${BRIDGE_PROTOCOL}`, 409);
    this.name = 'BridgeOutdatedError';
    this.theirs = theirs;
  }
}

/**
 * One call: `answer` is the kind of a 2xx answer, `send` the request's kind and object if it has a
 * body. Resolves to the answer's object; throws BridgeError on a 4xx or 5xx (its b_error message)
 * and BridgeOutdatedError when the add-on speaks another protocol.
 */
async function bridgeFetch(baseUrl, token, path, answer, { method = 'GET', send, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'X-Amgi-Bridge-Token': token,
        [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL),
        ...(send ? { 'Content-Type': WIRE_MIME } : {}),
      },
      body: send ? encode(send[0], send[1]) : undefined,
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const theirs = response.headers.get(PROTOCOL_HEADER) || '';
    if (theirs !== String(BRIDGE_PROTOCOL)) {
      // A refusal of the token or the origin from an add-on too old to name its protocol says nothing
      // about its version: only an answer (or the new add-on's own 409) does.
      if (response.ok || response.status === 409) throw new BridgeOutdatedError(theirs);
      throw new BridgeError(`bridge responded ${response.status}`, response.status);
    }
    if (!response.ok) {
      const error = decode('b_error', bytes);
      throw new BridgeError(error?.error || `bridge responded ${response.status}`, response.status);
    }
    const data = decode(answer, bytes);
    if (!data) throw new BridgeError(`the bridge's answer is not a whole ${answer} message`, 502);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** A live handle to a reachable bridge, matching directClient.js's shape (see transport.js). */
function createBridgeOps(baseUrl, token) {
  const call = (path, answer, options) => bridgeFetch(baseUrl, token, path, answer, options);
  const write = (method, path, answer, send) => call(path, answer, { method, send, timeoutMs: OPERATION_TIMEOUT_MS });
  return {
    mode: 'bridge',

    async status() {
      return call('/status', 'b_status');
    },
    async listDecks() {
      return (await call('/decks', 'b_decks')).decks;
    },
    async listNotetypes() {
      return (await call('/notetypes', 'b_notetypes')).notetypes;
    },
    async listNotesInDeck(deckId, { offset = 0, limit = 50 } = {}) {
      return call(`/decks/${deckId}/notes?offset=${offset}&limit=${limit}`, 'b_notes');
    },
    async countNotesInDeck(deckId) {
      return (await call(`/decks/${deckId}/notes?offset=0&limit=1`, 'b_notes')).total;
    },
    /** Every value already in `fieldIndex` for `notetypeId`'s notes in `deckId` - the bulk-add-vs-deck dupe check. */
    async existingFieldValues(deckId, notetypeId, fieldIndex) {
      const result = await call(
        `/decks/${deckId}/notes/field-values?notetypeId=${notetypeId}&fieldIndex=${fieldIndex}`,
        'b_values',
        // Reads every note in the deck, so its cost is the deck's size, not
        // this request's. It is also the bulk-add screen's dupe check, whose
        // failure is swallowed by design (ui/src/bulk.c) - timing this one out
        // does not show an error, it silently pays Gemini to regenerate
        // cards the deck already has.
        { timeoutMs: OPERATION_TIMEOUT_MS },
      );
      return result.values;
    },
    async createDeck(name) {
      const made = await write('POST', '/decks', 'b_deck_created', ['q_deck_name', { name }]);
      return { deck: { id: made['deck.id'], name: made['deck.name'] }, created: made.created };
    },
    async addNote(note) {
      return withoutEmptyWarning(await write('POST', '/notes', 'b_note', ['q_note', note]));
    },
    /**
     * Add several notes through one `POST /notes/bulk` call, which the
     * add-on's dispatcher runs as a single `CollectionOp` (see
     * bridge_ops.add_notes_bulk) - one undo step and one round of Anki's own
     * change-hook firing for the whole paste, instead of 60 of each.
     */
    async addNotesBulk(notes) {
      return (await write('POST', '/notes/bulk', 'b_notes_added', ['q_notes', { notes }])).results;
    },
    async updateNote(noteId, fields, language, learningFieldIndex) {
      const send = ['q_note_update', { fields, language, learningFieldIndex }];
      return withoutEmptyWarning(await write('PATCH', `/notes/${noteId}`, 'b_note', send));
    },
    async hasMedia(filename) {
      return (await call(`/media/${encodeURIComponent(filename)}`, 'b_media_exists')).exists;
    },
    async renameDeck(deckId, name) {
      return write('PATCH', `/decks/${deckId}`, 'b_deck', ['q_deck_name', { name }]);
    },
    /** GET /decks/:id: what deleting it would take. A deck that is not there is a BridgeError with status 404. */
    async deckRemovalSummary(deckId) {
      return call(`/decks/${deckId}`, 'b_deck_summary', { timeoutMs: OPERATION_TIMEOUT_MS });
    },
    /** DELETE /decks/:id, through Anki's own col.decks.remove (bridge_ops.remove_deck). */
    async removeDeck(deckId) {
      return write('DELETE', `/decks/${deckId}`, 'b_deck_removed');
    },
    async removeNote(noteId) {
      return write('DELETE', `/notes/${noteId}`, 'b_note_removed');
    },
    async readMedia(filename) {
      const result = await call(`/media/${encodeURIComponent(filename)}/data`, 'b_media_data');
      return result.found ? result.data : null;
    },
    async addMedia(filename, data) {
      return (await write('POST', '/media', 'b_media_added', ['b_q_media', { filename, data }])).filename;
    },
  };
}

// The wire carries "no warning" as "", where the JSON answers left the key out: callers test it.
function withoutEmptyWarning(answer) {
  const { warning, ...rest } = answer;
  return warning ? answer : rest;
}

/**
 * Probe a configured bridge. Resolves to { ops, status } when it answers in this server's protocol,
 * { outdated: error } when it answers in another, and null when it does not answer at all (the
 * caller falls back to the direct transport).
 */
export async function probeBridge(baseUrl, token) {
  try {
    const status = await bridgeFetch(baseUrl, token, '/status', 'b_status', { timeoutMs: DEFAULT_TIMEOUT_MS });
    return { ops: createBridgeOps(baseUrl, token), status };
  } catch (error) {
    if (error instanceof BridgeOutdatedError) return { outdated: error };
    return null;
  }
}
