'use strict';

// Public entry point: a thin, stateless-except-for-backup wrapper around the
// modules in this directory. See the module comments in open.js, decks.js,
// media.js and backup.js for the interesting decisions; this file mostly just
// wires them together and enforces "back up before the first mutation" (the
// one piece of state a caller needs across several calls).

const { defaultBaseDir, listProfiles } = require('./paths');
const { openCollection } = require('./open');
const { backupCollectionFile } = require('./backup');
const { listDecks, resolveOrCreateDeck } = require('./decks');
const { readNotetypes } = require('./notetypes');
const { addNote, listNotesInDeck, updateNoteFields } = require('./notes');
const { addMediaFile, mediaDirFor } = require('./media');
const { withCollection } = require('./open');

/**
 * A handle to one collection.anki2 path. Never holds a database connection
 * between method calls (see open.js) - what it does hold is whether it has
 * already backed up this collection, so a session that calls several
 * mutating methods only pays for one backup, taken before the first of them.
 */
class Collection {
  constructor(collectionPath) {
    this.path = collectionPath;
    this._backedUp = false;
  }

  /** Probe the collection without mutating anything. */
  status() {
    const opened = openCollection(this.path);
    if (opened.status === 'ok') opened.close();
    return opened.status === 'ok'
      ? { status: 'ok', schemaVersion: opened.schemaVersion }
      : { status: opened.status };
  }

  listDecks() {
    return listDecks(this.path);
  }

  listNotetypes() {
    return withCollection(this.path, ({ db, schemaVersion, path: p }) => {
      const notetypes = readNotetypes(db, schemaVersion, p);
      return [...notetypes.values()];
    });
  }

  listNotesInDeck(deckId, options) {
    return listNotesInDeck(this.path, deckId, options);
  }

  createDeck(humanName) {
    return this._withBackup(() => resolveOrCreateDeck(this.path, humanName));
  }

  addNote(note) {
    return this._withBackup(() => addNote(this.path, note));
  }

  updateNote(noteId, fields) {
    return this._withBackup(() => updateNoteFields(this.path, noteId, fields));
  }

  /**
   * Media is not gated on the collection's lock at all: collection.media/ is
   * an ordinary folder, not the exclusively-locked SQLite file, and Anki
   * picks up a file dropped into it whether or not Anki is currently running
   * (see media.js). It is still covered by the same one-backup-per-session
   * policy as the database-touching methods, for a uniform "this session has
   * made changes, here is a safety net" guarantee.
   */
  addMedia(desiredName, data) {
    this._ensureBackedUp();
    return addMediaFile(mediaDirFor(this.path), desiredName, data);
  }

  /**
   * Probe the lock (closing immediately either way, per open.js), then take
   * the one-per-session backup, then run the real mutation - in that order,
   * so a locked collection is never copied. Anki's own manual warns that
   * copying a collection while Anki has it open risks a torn (WAL-inconsistent)
   * copy; checking first means this module never does that, and a 'locked'
   * result is returned exactly as it would be from `fn` itself.
   */
  _withBackup(fn) {
    const probe = openCollection(this.path);
    if (probe.status !== 'ok') return probe;
    probe.close();
    this._ensureBackedUp();
    return fn();
  }

  _ensureBackedUp() {
    if (this._backedUp) return;
    this._backupPath = backupCollectionFile(this.path);
    this._backedUp = true;
  }
}

module.exports = { Collection, defaultBaseDir, listProfiles };
