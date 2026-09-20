'use strict';

// Reading and writing notes - and, for a new note, the cards its note type's
// templates imply.
//
// The sync bookkeeping (usn = -1, note/card mod, col.mod) is the whole reason
// this package exists rather than a five-line SQL script: skip it and Anki's
// sync silently reverts the edit on the next round-trip (see the module-level
// research this task was built from - "usn = -1 on rows you change, bump
// col.mod" - and vendor/anki-src/rslib/src/storage/sync.rs, which is what
// decides what gets uploaded). Every write in this file sets it.

const { fieldChecksum, joinFields, splitFields, stripHtmlPreservingMedia } = require('../deck');
const { idAllocationExpr, randomGuid } = require('./ids');
const { deckAndChildIds } = require('./decks');
const { withCollection } = require('./open');
const { ordinalsForNewNote } = require('./template');
const { readNotetypes } = require('./notetypes');
const { looksRomanized } = require('../cardGeneration/cardText.ts');

/** A `(?,?,...)` placeholder list sized to `ids`, for an SQL `IN (...)` clause. */
function placeholders(ids) {
  return ids.map(() => '?').join(',');
}

/**
 * A human-readable nudge when the note's LEARNING-language field looks
 * romanised - see cardText.ts's looksRomanized for the policy and why this
 * warns rather than refuses. Both `language` and `learningFieldIndex` are
 * optional and caller-supplied (the add-note form's language picker and its
 * "read aloud" field choice, or a CLI's --language/--text-field); omitting
 * either just means nothing is checked, the same as today.
 *
 * Deliberately does NOT scan every field: a note's known-language side is
 * routinely plain English (or whatever the learner already speaks), and
 * flagging that would be noise on almost every note rather than a signal on
 * the rare bad one. Only the one field the caller identifies as the
 * learning-language text is ever checked.
 */
function romanizationWarning(fieldNames, fields, language, learningFieldIndex) {
    if (!language || !Number.isInteger(learningFieldIndex)) return undefined;
    const text = fields[learningFieldIndex];
    if (!looksRomanized(text, language)) return undefined;
    const name = fieldNames[learningFieldIndex] ?? `field ${learningFieldIndex}`;
    return `"${name}" looks fully romanised for a ${language} note - check it is not meant to be written in ${language}'s own script.`;
}

const NOTE_ADD_ID = idAllocationExpr('notes');
const CARD_ADD_ID = idAllocationExpr('cards');

// vendor/anki-src/rslib/src/storage/note/add.sql, column order, with the id
// expression from ids.js standing in for add.sql's own CASE (identical SQL,
// just parameterised by table name so decks.js and this file share it).
const INSERT_NOTE_SQL = `
  INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
  VALUES (${NOTE_ADD_ID}, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
`;

// vendor/anki-src/rslib/src/storage/note/update.sql, plus `mod`/`usn`, which
// that file's caller (storage/note/mod.rs, SqliteStorage::update_note) always
// supplies from the in-memory Note it is writing back - update.sql's own
// column list is reproduced here unchanged.
const UPDATE_NOTE_SQL = `
  UPDATE notes SET mod = ?, usn = -1, flds = ?, sfld = ?, csum = ? WHERE id = ?
`;

// vendor/anki-src/rslib/src/storage/card/add_card.sql, column order and
// defaults for a freshly generated, never-reviewed card: type=0 (new),
// queue=0 (new), ivl/factor/reps/lapses/left/odue/odid/flags all zero, and
// data='{}' - storage/card/data.rs's CardData serializes to that for a card
// with no FSRS state, no original position and no v3 custom-scheduling data,
// which is exactly what a card fresh out of generate_cards_for_new_note has.
const INSERT_CARD_SQL = `
  INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
  VALUES (${CARD_ADD_ID}, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')
`;

function nextCardPositionLegacy(db) {
  const conf = JSON.parse(db.prepare('SELECT conf FROM col').get().conf);
  const pos = conf.nextPos ?? 1;
  conf.nextPos = pos + 1;
  db.prepare('UPDATE col SET conf = ? WHERE id = 1').run(JSON.stringify(conf));
  return pos;
}

function nextCardPositionSchema18(db) {
  // config.mod.rs, ConfigKey::NextNewCardPosition ("nextPos"): stored as a
  // JSON-serialized number, same encoding as everywhere else in the config
  // table (config/mod.rs, Collection::set_config).
  const row = db.prepare("SELECT val FROM config WHERE KEY = 'nextPos'").get();
  const pos = row ? JSON.parse(Buffer.from(row.val).toString('utf8')) : 1;
  const nextVal = Buffer.from(JSON.stringify(pos + 1), 'utf8');
  db.prepare(
    "INSERT INTO config (KEY, usn, mtime_secs, val) VALUES ('nextPos', -1, ?, ?) " +
      'ON CONFLICT(KEY) DO UPDATE SET usn = -1, mtime_secs = excluded.mtime_secs, val = excluded.val',
  ).run(Math.floor(Date.now() / 1000), nextVal);
  return pos;
}

function nextCardPosition(db, schemaVersion) {
  return schemaVersion === 11 ? nextCardPositionLegacy(db) : nextCardPositionSchema18(db);
}

function touchCollectionMod(db) {
  db.prepare('UPDATE col SET mod = ? WHERE id = 1').run(Date.now());
}

/**
 * How many notes belong to `deckId` or one of its subdecks (via their
 * cards) - the same join listNotesInDeck pages through, just counted instead
 * of fetched, so a caller building a deck list with note counts pays for one
 * small COUNT(DISTINCT ...) per deck rather than loading every row.
 *
 * Same deck-and-descendants scope as listNotesInDeck (see decks.js's
 * deckAndChildIds): the total this returns must match what paging through
 * listNotesInDeck would actually enumerate, page by page, or a UI showing
 * both would disagree with itself.
 */
function countNotesInDeck(collectionPath, deckId) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const deckIds = deckAndChildIds(db, schemaVersion, deckId);
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT n.id) AS total FROM notes n JOIN cards c ON c.nid = n.id
         WHERE c.did IN (${placeholders(deckIds)})`,
      )
      .get(...deckIds);
    return Number(row.total);
  });
}

/**
 * Notes belonging to `deckId` or one of its subdecks (via their cards),
 * oldest id first, paginated so a large collection is never loaded in one
 * gulp. See decks.js's deckAndChildIds for why subdecks are included: this
 * mirrors bridge_ops.py's list_notes_in_deck (col.decks.deck_and_child_ids),
 * so browsing the same deck gives the same notes whether Anki is open or
 * closed.
 */
function listNotesInDeck(collectionPath, deckId, { offset = 0, limit = 200 } = {}) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const deckIds = deckAndChildIds(db, schemaVersion, deckId);
    const rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.mid, n.flds, n.tags
         FROM notes n JOIN cards c ON c.nid = n.id
         WHERE c.did IN (${placeholders(deckIds)})
         ORDER BY n.id
         LIMIT ? OFFSET ?`,
      )
      .all(...deckIds, limit, offset);
    return rows.map((row) => ({
      id: Number(row.id),
      notetypeId: Number(row.mid),
      fields: splitFields(row.flds),
      tags: row.tags.trim().length > 0 ? row.tags.trim().split(/\s+/) : [],
    }));
  });
}

/**
 * The actual insert work for one note, given an already-open `db` and an
 * already-read `notetypes` map - the part addNote and addNotesBulk share, so
 * a bulk paste of thousands of lines reads the note type table and opens the
 * collection file exactly once for the whole batch rather than once per
 * line. Throws on a bad note (unknown note type, wrong field count) exactly
 * as addNote always did; callers that need one bad note to not abort a whole
 * batch (addNotesBulk) catch around this call themselves, the same
 * per-note-isolated contract bridge_ops.add_notes_bulk already has on the
 * bridge side.
 */
function insertOneNote(db, schemaVersion, notetypes, { deckId, notetypeId, fields, tags = [], language, learningFieldIndex }) {
  const notetype = notetypes.get(notetypeId);
  if (!notetype) throw new Error(`no note type with id ${notetypeId} in this collection`);
  if (fields.length !== notetype.fieldNames.length) {
    throw new Error(`note type "${notetype.name}" has ${notetype.fieldNames.length} fields, got ${fields.length}`);
  }
  const warning = romanizationWarning(notetype.fieldNames, fields, language, learningFieldIndex);

  const now = Math.floor(Date.now() / 1000);
  const guid = randomGuid();
  const flds = joinFields(fields);
  // notes/mod.rs, prepare_for_update: the checksum and sort field are always
  // derived from stripped (media-filename-preserving) text, and the checksum
  // specifically always comes from field 0 regardless of which field is the
  // sort field.
  const sortText = stripHtmlPreservingMedia(fields[notetype.sortFieldIndex] ?? '');
  const csum = fieldChecksum(stripHtmlPreservingMedia(fields[0] ?? ''));
  const tagsField = tags.length > 0 ? ` ${tags.join(' ')} ` : '';

  // Date.now() can and does repeat across notes inserted this close together
  // in a bulk batch - idAllocationExpr's own CASE WHEN ... ELSE max(id) + 1
  // handles that collision at INSERT time (see ids.js), the same way it
  // already tolerates repeats across the per-ordinal card loop below, so
  // sharing one open connection across a whole batch never risks a duplicate id.
  const wantedNoteId = Date.now();
  const noteResult = db
    .prepare(INSERT_NOTE_SQL)
    .run(wantedNoteId, guid, notetypeId, now, -1, tagsField, flds, sortText, csum);
  const insertedNoteId = noteResult.lastInsertRowid;

  const ordinals = ordinalsForNewNote({
    kind: notetype.kind,
    templates: notetype.templates,
    fieldNames: notetype.fieldNames,
    fieldValues: fields,
    tags,
  });

  const cardIds = [];
  for (const ord of ordinals) {
    const due = nextCardPosition(db, schemaVersion);
    const wantedCardId = Date.now();
    const cardResult = db.prepare(INSERT_CARD_SQL).run(wantedCardId, insertedNoteId, deckId, ord, now, due);
    cardIds.push(Number(cardResult.lastInsertRowid));
  }

  return { noteId: Number(insertedNoteId), guid, cardIds, ...(warning ? { warning } : {}) };
}

/**
 * Add a note to `deckId`, generating whatever cards its note type's templates
 * (or cloze numbers) call for - see template.js for that decision.
 *
 * @param {string} collectionPath
 * @param {object} note
 * @param {number} note.deckId
 * @param {number} note.notetypeId
 * @param {string[]} note.fields  one entry per field, in the note type's field order
 * @param {string[]} [note.tags]
 * @param {string} [note.language]  the learning language, for the romanisation guard only
 * @param {number} [note.learningFieldIndex]  which field is the learning-language text, for the same guard
 */
function addNote(collectionPath, note) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const notetypes = readNotetypes(db, schemaVersion);
    const result = insertOneNote(db, schemaVersion, notetypes, note);
    touchCollectionMod(db);
    return result;
  });
}

/**
 * Add several notes as one unit of work: one collection open, one
 * readNotetypes, one col.mod bump - not one of each per note.
 *
 * Before this existed, direct-mode's bulk-add-from-paste screen (see
 * directClient.js's addNotesBulk) added notes by calling addNote() in a
 * plain loop, which reopened the collection file (and, until the
 * withLiveCollationsRelaxed fix, re-copied the *entire* file - see
 * relaxed-read.js) once per line. That made a bulk paste's cost scale with
 * both the batch size and the collection's own size, the opposite of what a
 * "paste 2000 lines" screen should cost. This is the direct-mode equivalent
 * of what the bridge already did by wrapping a whole batch in one
 * CollectionOp (bridge_ops.add_notes_bulk) - same one-open-per-batch shape,
 * just without Anki's own operation queue underneath it.
 *
 * Each note is validated and added independently: one bad note (wrong field
 * count, unknown note type) is reported in its own result slot rather than
 * aborting notes already added earlier in the same batch - a paste is a
 * batch of independent lines, not a single transaction that should all fail
 * together over one bad line, matching bridge_ops.add_notes_bulk's contract
 * exactly.
 */
function addNotesBulk(collectionPath, notes) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const notetypes = readNotetypes(db, schemaVersion);
    const results = notes.map((note) => {
      try {
        return { ok: true, ...insertOneNote(db, schemaVersion, notetypes, note) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    touchCollectionMod(db);
    return results;
  });
}

/**
 * Replace a note's field contents in place. Does not touch tags, does not
 * regenerate cards - see readme/report for why a field-content edit never
 * needs to (a card's existence was decided once, at add time, from the note
 * type's templates; changing field text doesn't retroactively remove or add
 * cards in real Anki either, short of a full "empty cards" pass).
 */
function updateNoteFields(collectionPath, noteId, fields, language, learningFieldIndex) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const existing = db.prepare('SELECT mid FROM notes WHERE id = ?').get(noteId);
    if (!existing) throw new Error(`no note with id ${noteId} in this collection`);

    const notetypes = readNotetypes(db, schemaVersion);
    const notetype = notetypes.get(Number(existing.mid));
    if (!notetype) throw new Error(`note ${noteId} has an unknown note type`);
    if (fields.length !== notetype.fieldNames.length) {
      throw new Error(
        `note type "${notetype.name}" has ${notetype.fieldNames.length} fields, got ${fields.length}`,
      );
    }
    const warning = romanizationWarning(notetype.fieldNames, fields, language, learningFieldIndex);

    const now = Math.floor(Date.now() / 1000);
    const flds = joinFields(fields);
    const sortText = stripHtmlPreservingMedia(fields[notetype.sortFieldIndex] ?? '');
    const csum = fieldChecksum(stripHtmlPreservingMedia(fields[0] ?? ''));

    db.prepare(UPDATE_NOTE_SQL).run(now, flds, sortText, csum, noteId);
    touchCollectionMod(db);
    return warning ? { warning } : undefined;
  });
}

/**
 * The raw value of one field, for every note with a card in `deckId` (or one
 * of its subdecks) and note type `notetypeId` - what a bulk-add paste screen
 * checks "is this line already in the deck" against, without paging through
 * full note objects the way listNotesInDeck does (a bulk paste needs the
 * whole set at once to dedupe against, not a page at a time).
 *
 * Scoped to one note type deliberately: bulk add only ever writes into the
 * note type the caller chose in CardForm, so comparing against a different
 * note type's differently-shaped fields would be comparing unrelated text.
 * Same deck-and-descendants scope as countNotesInDeck/listNotesInDeck (see
 * decks.js's deckAndChildIds) plus the note-type filter, still one indexed
 * join per deck id. Without this, re-pasting a song into a deck that
 * organizes its cards into subdecks would not see the copies already sitting
 * in a subdeck and would happily duplicate them.
 */
function noteFieldValuesInDeck(collectionPath, deckId, notetypeId, fieldIndex) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const deckIds = deckAndChildIds(db, schemaVersion, deckId);
    const rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.flds
         FROM notes n JOIN cards c ON c.nid = n.id
         WHERE c.did IN (${placeholders(deckIds)}) AND n.mid = ?`,
      )
      .all(...deckIds, notetypeId);
    return rows.map((row) => splitFields(row.flds)[fieldIndex] ?? '');
  });
}

/**
 * Delete a note and its cards, the way Anki deletes them.
 *
 * The rows themselves are the easy half. The half that matters for a
 * collection that syncs is the `graves` table: Anki records every deletion
 * there so the next sync can tell "this note was deleted" apart from "this
 * client has never seen this note", and a client that deletes rows without
 * leaving a grave gets the note pushed straight back to it from AnkiWeb
 * (vendor/anki-src/rslib/src/storage/note/mod.rs, `remove_note`, and
 * sync/mod.rs's handling of pending graves). The type codes are Anki's own:
 * 0 for a card, 1 for a note, 2 for a deck.
 *
 * usn = -1 on the graves for the same reason it is -1 on every other row
 * this module writes: it marks the change as not yet sent to the server.
 */
function removeNote(collectionPath, noteId) {
  return withCollection(collectionPath, ({ db }) => {
    const existing = db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId);
    if (!existing) throw new Error(`no note with id ${noteId} in this collection`);

    const cardIds = db.prepare('SELECT id FROM cards WHERE nid = ?').all(noteId).map((row) => Number(row.id));
    const grave = db.prepare('INSERT INTO graves (usn, oid, type) VALUES (-1, ?, ?)');
    for (const cardId of cardIds) grave.run(cardId, 0);
    grave.run(Number(noteId), 1);

    db.prepare('DELETE FROM cards WHERE nid = ?').run(noteId);
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    touchCollectionMod(db);
    return { noteId: Number(noteId), cardsRemoved: cardIds.length };
  });
}

module.exports = {
  addNote,
  removeNote,
  addNotesBulk,
  countNotesInDeck,
  listNotesInDeck,
  noteFieldValuesInDeck,
  updateNoteFields,
};
