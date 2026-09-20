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
const {
  addNote,
  addNotesBulk,
  countNotesInDeck,
  listNotesInDeck,
  noteFieldValuesInDeck,
  updateNoteFields,
} = require('./notes');
const { addMediaFile, mediaDirFor, mediaFileExists, readMediaFile } = require('./media');
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
    return withCollection(this.path, ({ db, schemaVersion }) => {
      const notetypes = readNotetypes(db, schemaVersion);
      return [...notetypes.values()];
    });
  }

  listNotesInDeck(deckId, options) {
    return listNotesInDeck(this.path, deckId, options);
  }

  /** How many notes are in `deckId`, without paging through them - see notes.js. */
  countNotesInDeck(deckId) {
    return countNotesInDeck(this.path, deckId);
  }

  /** One field's value across every note of `notetypeId` already in `deckId` - see notes.js. */
  listFieldValuesInDeck(deckId, notetypeId, fieldIndex) {
    return noteFieldValuesInDeck(this.path, deckId, notetypeId, fieldIndex);
  }

  createDeck(humanName) {
    return this._withBackup(() => resolveOrCreateDeck(this.path, humanName));
  }

  addNote(note) {
    return this._withBackup(() => addNote(this.path, note));
  }

  /**
   * Add several notes as one unit of work - one collection open, one
   * notetypes read, one backup, for the whole batch. See notes.js's
   * addNotesBulk for why this exists as its own primitive rather than a
   * caller looping over addNote(): a loop reopens (and, before that fix,
   * fully re-copies) the collection file once per note, which turns a bulk
   * paste's cost into a function of both the batch size and the collection's
   * own size.
   */
  addNotesBulk(notes) {
    return this._withBackup(() => addNotesBulk(this.path, notes));
  }

  updateNote(noteId, fields, language, learningFieldIndex) {
    return this._withBackup(() => updateNoteFields(this.path, noteId, fields, language, learningFieldIndex));
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
   * Whether a content-hashed clip name (see plusaudio/lib/audio-store.js's
   * mediaName) is already sitting in this collection's media folder - a
   * plain file check, no backup needed since nothing is written. This is
   * what makes re-running audio generation over a deck free for the clips it
   * already made: the caller checks this before spending an API call, not
   * after.
   */
  /** The bytes of a media file, or null. Reads the media folder, never the
   *  collection database, so it works whether or not Anki holds the lock. */
  readMedia(filename) {
    return readMediaFile(mediaDirFor(this.path), filename);
  }

  hasMedia(filename) {
    return mediaFileExists(mediaDirFor(this.path), filename);
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
