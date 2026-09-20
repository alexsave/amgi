'use strict';

// Public entry point: a thin, stateless wrapper around the modules in this
// directory. See the module comments in open.js, decks.js, media.js and
// backup.js for the interesting decisions; this file mostly just wires them
// together and enforces "back up before changing anything", which backup.js
// then decides whether an existing copy already satisfies.

const { defaultBaseDir, listProfiles } = require('./paths');
const { openCollection } = require('./open');
const { ensureBackupBeforeChange, noteCollectionWritten, readCollectionMark } = require('./backup');
const { listDecks, renameDeck, resolveOrCreateDeck } = require('./decks');
const { readNotetypes } = require('./notetypes');
const {
  addNote,
  addNotesBulk,
  countNotesInDeck,
  listNotesInDeck,
  noteFieldValuesInDeck,
  updateNoteFields,
  removeNote,
} = require('./notes');
const { addMediaFile, mediaDirFor, mediaFileExists, readMediaFile } = require('./media');
const { withCollection } = require('./open');

/**
 * A handle to one collection.anki2 path. Holds nothing at all: no database
 * connection between method calls (see open.js), and - since the backup
 * policy moved into backup.js, keyed by path - no backup state either.
 *
 * That second part used to be a flag on this object, which quietly assumed
 * one instance meant one working session. src/server/anki/transport.js builds
 * a Collection per HTTP request, so the assumption was false where it mattered
 * most and every mutating request copied the whole collection file. Constructing
 * these freely, per request or per call, is now exactly as cheap as it looks;
 * backup.js's module header has the policy and the guarantee it makes.
 */
class Collection {
  constructor(collectionPath) {
    this.path = collectionPath;
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

  /** Rename a deck and everything under it. */
  renameDeck(deckId, humanName) {
    return this._withBackup(() => renameDeck(this.path, deckId, humanName));
  }

  /** Delete a note and its cards, leaving graves so a sync propagates it. */
  removeNote(noteId) {
    return this._withBackup(() => removeNote(this.path, noteId));
  }

  updateNote(noteId, fields, language, learningFieldIndex) {
    return this._withBackup(() => updateNoteFields(this.path, noteId, fields, language, learningFieldIndex));
  }

  /**
   * Media is not gated on the collection's lock at all: collection.media/ is
   * an ordinary folder, not the exclusively-locked SQLite file, and Anki
   * picks up a file dropped into it whether or not Anki is currently running
   * (see media.js). It is still covered by the same backup policy as the
   * database-touching methods, for a uniform "something is being changed here,
   * there is a safety net behind it" guarantee. No noteCollectionWritten()
   * afterwards, though: writing a clip into collection.media/ leaves the
   * collection file itself untouched, so what backup.js recorded about it is
   * still true.
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
   * Probe the lock (closing immediately either way, per open.js), back up if
   * this change needs a fresh one, then run the real mutation - in that order,
   * so a locked collection is never copied. Anki's own manual warns that
   * copying a collection while Anki has it open risks a torn (WAL-inconsistent)
   * copy; checking first means this module never does that, and a 'locked'
   * result is returned exactly as it would be from `fn` itself.
   *
   * The note-afterwards half is what keeps the next mutation from copying
   * again: it records how the file looks once our write has landed and the
   * connection is closed, so backup.js can tell our own edit from somebody
   * else's. It runs whatever `fn` returned - a mutation that reported a
   * problem may still have changed the file.
   */
  _withBackup(fn) {
    const probe = openCollection(this.path);
    if (probe.status !== 'ok') return probe;
    // Read the "has anyone else changed this" mark off the probe's own handle
    // rather than letting backup.js open the file a second time to do it.
    const mark = readCollectionMark(this.path, probe.db);
    probe.close();
    this._ensureBackedUp(mark);
    try {
      return fn();
    } finally {
      noteCollectionWritten(this.path);
    }
  }

  /** `mark` comes from a handle the caller already has open, when there is one - see backup.js. */
  _ensureBackedUp(mark = readCollectionMark(this.path)) {
    const backupPath = ensureBackupBeforeChange(this.path, { mark });
    if (backupPath) this._backupPath = backupPath;
  }
}

module.exports = { Collection, defaultBaseDir, listProfiles };
