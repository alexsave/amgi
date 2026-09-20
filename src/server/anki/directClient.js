// Talking to a closed collection's .anki2 file directly, through
// plusaudio/lib/collection - the "Anki closed" transport. Node-only (it
// touches node:sqlite and the filesystem), which is exactly why this module
// must never be imported from a client component; see transport.js's module
// comment for where that boundary is actually enforced, and next.config.js's
// `serverExternalPackages` for why this plain import doesn't get bundled.

import path from 'node:path';
import { Collection } from 'plusaudio/lib/collection';

export class DirectError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'DirectError';
    this.kind = kind; // 'locked' | 'not-found' | 'unsupported-schema'
  }
}

/** Unwrap the {status, result} shape every Collection method returns into a plain value, or throw. */
function unwrap(outcome) {
  if (outcome.status === 'ok') return outcome.result;
  throw new DirectError(`collection is ${outcome.status}`, outcome.status);
}

// plusaudio/lib/collection opens and closes a fresh connection per call
// rather than holding one open (see its open.js module comment - that is
// deliberate, so this app never holds the file open the way a running Anki
// does). The cost of that design is that two calls from *this process*
// landing at the same instant - the status banner's poll racing a page's
// own data fetch, say - can each try to open the file at once and trip
// SQLite's zero-second busy timeout against each other, which
// plusaudio/lib/collection cannot tell apart from a real external lock and
// reports as 'locked' either way. That would show the user "Anki is open"
// when it is not, which defeats the whole point of a mode banner they can
// trust. Serializing every direct-mode call through one promise chain per
// collection path means only one call ever has the file open at a time from
// this app's side, so a 'locked' result can only mean what it claims to.
//
// One chain per collection *path*, keyed the same way plusaudio's backup
// ledger keys its own state (path.resolve), for two reasons that pull in
// opposite directions. Different paths must not share a chain: switching
// profiles would otherwise make each profile's calls queue behind the other's
// for no reason, and a test's temp collection would serialize against the real
// one. And one path must not end up with two chains because it was spelled two
// ways ('.../collection.anki2' vs '.../foo/../collection.anki2'), since that
// is two callers holding the same file open at once - exactly the false
// 'locked' this map exists to prevent.
const collectionQueues = new Map();

function withCollectionLock(collectionPath, fn) {
  const key = path.resolve(collectionPath);
  const previous = collectionQueues.get(key) || Promise.resolve();
  const result = previous.then(fn, fn);
  // A tail that always resolves, so one call's rejection never wedges every
  // call after it - each caller still sees its own `result` reject normally.
  collectionQueues.set(key, result.then(() => {}, () => {}));
  return result;
}

/**
 * A live handle to a readable collection file, matching bridgeClient.js's
 * shape (see transport.js).
 *
 * transport.js calls this once per HTTP request, on purpose ("nothing here is
 * cached across requests"), so the Collection below is built per request too.
 * That is free: Collection holds no connection and, since the backup policy
 * moved into plusaudio/lib/collection/backup.js keyed by path, no per-instance
 * state either. It was not always free - a per-instance "already backed up"
 * flag meant a per-request instance re-copied the whole collection file on
 * every mutating request - so if a caching layer ever looks tempting here,
 * read that module's header first: the reason it is not needed is also the
 * reason caching it would be wrong.
 */
export function createDirectOps(collectionPath) {
  const col = new Collection(collectionPath);
  const locked = (fn) => withCollectionLock(collectionPath, fn);
  return {
    mode: 'direct',

    async status() {
      return locked(() => col.status());
    },
    async listDecks() {
      return locked(() => unwrap(col.listDecks()));
    },
    async listNotetypes() {
      return locked(() => unwrap(col.listNotetypes()));
    },
    async listNotesInDeck(deckId, { offset = 0, limit = 50 } = {}) {
      // Fetch one extra row to know whether another page exists without a
      // second COUNT(*) on every page turn - only the deck-list screen needs
      // the real total, and it asks countNotesInDeck for that directly.
      const notes = await locked(() => unwrap(col.listNotesInDeck(deckId, { offset, limit: limit + 1 })));
      const hasMore = notes.length > limit;
      return { notes: notes.slice(0, limit), offset, limit, hasMore };
    },
    async countNotesInDeck(deckId) {
      return locked(() => unwrap(col.countNotesInDeck(deckId)));
    },
    /** Every value already in `fieldIndex` for `notetypeId`'s notes in `deckId` - the bulk-add-vs-deck dupe check. */
    async existingFieldValues(deckId, notetypeId, fieldIndex) {
      return locked(() => unwrap(col.listFieldValuesInDeck(deckId, notetypeId, fieldIndex)));
    },
    async createDeck(name) {
      return locked(() => unwrap(col.createDeck(name)));
    },
    async addNote(note) {
      return locked(() => unwrap(col.addNote(note)));
    },
    /**
     * Add several notes as one unit of work, via plusaudio/lib/collection's
     * own addNotesBulk - one collection open and one notetypes read for the
     * whole batch, not one per note (see notes.js's addNotesBulk for why a
     * per-note loop was a real, measured scaling problem: it used to reopen,
     * and before that even re-copy, the whole collection file once per line).
     * Also still runs inside a single lock acquisition, so a paste of
     * thousands of lines doesn't interleave with some other request's own
     * direct-mode call mid-batch.
     */
    async addNotesBulk(notes) {
      return locked(() => unwrap(col.addNotesBulk(notes)));
    },
    async renameDeck(deckId, name) {
      return locked(() => unwrap(col.renameDeck(deckId, name)));
    },
    async removeNote(noteId) {
      return locked(() => unwrap(col.removeNote(noteId)));
    },
    async updateNote(noteId, fields, language, learningFieldIndex) {
      return locked(() => unwrap(col.updateNote(noteId, fields, language, learningFieldIndex)));
    },
    async hasMedia(filename) {
      return locked(() => col.hasMedia(filename));
    },
    async readMedia(filename) {
      // Like addMedia, this is an ordinary folder read rather than anything
      // the collection's lock covers.
      return locked(() => col.readMedia(filename));
    },
    async addMedia(filename, data) {
      // Unlike every other Collection method, addMedia returns the stored
      // filename directly rather than a {status, result} envelope - media
      // is an ordinary folder write, not gated on the collection's lock at
      // all (see plusaudio/lib/collection/index.js's own comment on why).
      return locked(() => col.addMedia(filename, data));
    },
  };
}
