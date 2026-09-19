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
const { withCollection } = require('./open');
const { ordinalsForNewNote } = require('./template');
const { readNotetypes } = require('./notetypes');

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
 * Notes belonging to `deckId` (via their cards), oldest id first, paginated
 * so a large collection is never loaded in one gulp.
 */
function listNotesInDeck(collectionPath, deckId, { offset = 0, limit = 200 } = {}) {
  return withCollection(collectionPath, ({ db }) => {
    const rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.mid, n.flds, n.tags
         FROM notes n JOIN cards c ON c.nid = n.id
         WHERE c.did = ?
         ORDER BY n.id
         LIMIT ? OFFSET ?`,
      )
      .all(deckId, limit, offset);
    return rows.map((row) => ({
      id: Number(row.id),
      notetypeId: Number(row.mid),
      fields: splitFields(row.flds),
      tags: row.tags.trim().length > 0 ? row.tags.trim().split(/\s+/) : [],
    }));
  });
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
 */
function addNote(collectionPath, { deckId, notetypeId, fields, tags = [] }) {
  return withCollection(collectionPath, ({ db, schemaVersion, path: collectionPath2 }) => {
    const notetypes = readNotetypes(db, schemaVersion, collectionPath2);
    const notetype = notetypes.get(notetypeId);
    if (!notetype) throw new Error(`no note type with id ${notetypeId} in this collection`);
    if (fields.length !== notetype.fieldNames.length) {
      throw new Error(
        `note type "${notetype.name}" has ${notetype.fieldNames.length} fields, got ${fields.length}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const guid = randomGuid();
    const flds = joinFields(fields);
    // notes/mod.rs, prepare_for_update: the checksum and sort field are
    // always derived from stripped (media-filename-preserving) text, and the
    // checksum specifically always comes from field 0 regardless of which
    // field is the sort field.
    const sortText = stripHtmlPreservingMedia(fields[notetype.sortFieldIndex] ?? '');
    const csum = fieldChecksum(stripHtmlPreservingMedia(fields[0] ?? ''));
    const tagsField = tags.length > 0 ? ` ${tags.join(' ')} ` : '';

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

    touchCollectionMod(db);

    return { noteId: Number(insertedNoteId), guid, cardIds };
  });
}

/**
 * Replace a note's field contents in place. Does not touch tags, does not
 * regenerate cards - see readme/report for why a field-content edit never
 * needs to (a card's existence was decided once, at add time, from the note
 * type's templates; changing field text doesn't retroactively remove or add
 * cards in real Anki either, short of a full "empty cards" pass).
 */
function updateNoteFields(collectionPath, noteId, fields) {
  return withCollection(collectionPath, ({ db, schemaVersion, path: collectionPath2 }) => {
    const existing = db.prepare('SELECT mid FROM notes WHERE id = ?').get(noteId);
    if (!existing) throw new Error(`no note with id ${noteId} in this collection`);

    const notetypes = readNotetypes(db, schemaVersion, collectionPath2);
    const notetype = notetypes.get(Number(existing.mid));
    if (!notetype) throw new Error(`note ${noteId} has an unknown note type`);
    if (fields.length !== notetype.fieldNames.length) {
      throw new Error(
        `note type "${notetype.name}" has ${notetype.fieldNames.length} fields, got ${fields.length}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const flds = joinFields(fields);
    const sortText = stripHtmlPreservingMedia(fields[notetype.sortFieldIndex] ?? '');
    const csum = fieldChecksum(stripHtmlPreservingMedia(fields[0] ?? ''));

    db.prepare(UPDATE_NOTE_SQL).run(now, flds, sortText, csum, noteId);
    touchCollectionMod(db);
  });
}

module.exports = { addNote, listNotesInDeck, updateNoteFields };
