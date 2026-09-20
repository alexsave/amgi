'use strict';

// Talking to a running anki/addon/amgi_bridge over localhost HTTP - the
// "Anki open" transport. See that add-on's README, "Local HTTP bridge", for
// the endpoint contract this mirrors and the auth model this relies on.
//
// This client only ever runs on the Next.js server (see transport.js's
// module comment), so the `fetch()` calls here never carry a browser
// `Origin` header at all - and bridge_auth.py treats "no Origin" as not an
// origin failure by design (a same-machine CLI caller, which this is). The
// shared-secret token is therefore the only credential these requests need.

const DEFAULT_TIMEOUT_MS = 1500;

class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

async function bridgeFetch(baseUrl, token, path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'X-Amgi-Bridge-Token': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new BridgeError(data?.error || `bridge responded ${response.status}`, response.status);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** A live handle to a reachable bridge, matching directClient.js's shape (see transport.js). */
function createBridgeOps(baseUrl, token) {
  return {
    mode: 'bridge',

    async status() {
      return bridgeFetch(baseUrl, token, '/status');
    },
    async listDecks() {
      return bridgeFetch(baseUrl, token, '/decks');
    },
    async listNotetypes() {
      return bridgeFetch(baseUrl, token, '/notetypes');
    },
    async listNotesInDeck(deckId, { offset = 0, limit = 50 } = {}) {
      return bridgeFetch(baseUrl, token, `/decks/${deckId}/notes?offset=${offset}&limit=${limit}`);
    },
    async countNotesInDeck(deckId) {
      const page = await bridgeFetch(baseUrl, token, `/decks/${deckId}/notes?offset=0&limit=1`);
      return page.total;
    },
    /** Every value already in `fieldIndex` for `notetypeId`'s notes in `deckId` - the bulk-add-vs-deck dupe check. */
    async existingFieldValues(deckId, notetypeId, fieldIndex) {
      const result = await bridgeFetch(
        baseUrl,
        token,
        `/decks/${deckId}/notes/field-values?notetypeId=${notetypeId}&fieldIndex=${fieldIndex}`,
      );
      return result.values;
    },
    async createDeck(name) {
      return bridgeFetch(baseUrl, token, '/decks', { method: 'POST', body: { name } });
    },
    async addNote(note) {
      return bridgeFetch(baseUrl, token, '/notes', { method: 'POST', body: note });
    },
    /**
     * Add several notes through one `POST /notes/bulk` call, which the
     * add-on's dispatcher runs as a single `CollectionOp` (see
     * bridge_ops.add_notes_bulk) - one undo step and one round of Anki's own
     * change-hook firing for the whole paste, instead of 60 of each.
     */
    async addNotesBulk(notes) {
      const result = await bridgeFetch(baseUrl, token, '/notes/bulk', { method: 'POST', body: { notes } });
      return result.results;
    },
    async updateNote(noteId, fields, language, learningFieldIndex) {
      return bridgeFetch(baseUrl, token, `/notes/${noteId}`, {
        method: 'PATCH',
        body: { fields, language, learningFieldIndex },
      });
    },
    async hasMedia(filename) {
      const result = await bridgeFetch(baseUrl, token, `/media/${encodeURIComponent(filename)}`);
      return result.exists;
    },
    async removeNote(noteId) {
      return bridgeFetch(baseUrl, token, `/notes/${noteId}`, { method: 'DELETE' });
    },
    async readMedia(filename) {
      const result = await bridgeFetch(baseUrl, token, `/media/${encodeURIComponent(filename)}/data`);
      return result.found ? Buffer.from(result.dataBase64, 'base64') : null;
    },
    async addMedia(filename, data) {
      const result = await bridgeFetch(baseUrl, token, '/media', {
        method: 'POST',
        body: { filename, dataBase64: data.toString('base64') },
      });
      return result.filename;
    },
  };
}

/** Probe a configured bridge; resolves to ops on success, null if unreachable (caller falls back to direct). */
async function probeBridge(baseUrl, token) {
  try {
    const status = await bridgeFetch(baseUrl, token, '/status', { timeoutMs: DEFAULT_TIMEOUT_MS });
    return { ops: createBridgeOps(baseUrl, token), status };
  } catch {
    return null;
  }
}

module.exports = { BridgeError, createBridgeOps, probeBridge };
