'use strict';

// Build a small legacy .apkg in memory, so the tests exercise the real reader
// and writer without carrying a 20 MB deck in the repository.

const { DatabaseSync } = require('node:sqlite');
const { writeZip } = require('../../lib/zip');

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null, usn integer not null,
  ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null, flds text not null,
  sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null, type integer not null,
  queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null,
  time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_csum on notes (csum);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_revlog_cid on revlog (cid);
`;

const NOTETYPE_ID = 1536343392138;
const DECK_ID = 1547243929876;

const MODELS = {
  [NOTETYPE_ID]: {
    id: NOTETYPE_ID,
    name: "Retro's sentences",
    type: 0,
    sortf: 2,
    did: DECK_ID,
    flds: [
      { name: 'Korean', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20 },
      { name: 'Audio', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20 },
      { name: 'Sort', ord: 2, sticky: false, rtl: false, font: 'Arial', size: 20 },
    ],
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Korean}}', afmt: '{{Audio}}', did: null }],
    css: '.card { font-size: 20px; }',
    latexPre: '',
    latexPost: '',
    req: [[0, 'any', [0]]],
    tags: [],
    usn: -1,
    vers: [],
    mod: 1536343392,
  },
};

const DECKS = {
  1: { id: 1, name: 'Default', mod: 0, conf: 1, desc: '', dyn: 0, collapsed: false, extendNew: 10, extendRev: 50 },
  [DECK_ID]: {
    id: DECK_ID,
    name: "Korean::문장::1. Retro's Beginner Grammar Sentences",
    mod: 1547243929,
    conf: 1,
    desc: '',
    dyn: 0,
    collapsed: false,
    extendNew: 10,
    extendRev: 50,
  },
};

const FIELD_SEPARATOR = '\x1f';

/**
 * @param {object} spec
 * @param {Array<{id, guid, fields: string[], mod, tags?}>} spec.notes
 * @param {Array<object>} [spec.revlog]
 * @param {object} [spec.media]   Anki filename -> contents
 * @param {'legacy1'|'legacy2'} [spec.format]
 */
function buildPackage(outPath, spec) {
  const format = spec.format ?? 'legacy1';
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare(
    'INSERT INTO col VALUES (1, 1536289200, 1599388703765, 1599388703000, 11, 0, 0, 0, ?, ?, ?, ?, ?)',
  ).run('{"schedVer": 2}', JSON.stringify(MODELS), JSON.stringify(DECKS), '{}', '{}');

  const insertNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, \'\')');
  const insertCard = db.prepare('INSERT INTO cards VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 2500, ?, 0, 0, 0, 0, 0, \'\')');
  spec.notes.forEach((note, index) => {
    insertNote.run(
      note.id,
      note.guid,
      NOTETYPE_ID,
      note.mod,
      note.usn ?? 100,
      note.tags ?? ' Beginner ',
      note.fields.join(FIELD_SEPARATOR),
      note.fields[2] ?? '',
      1234567 + index,
    );
    const card = note.card ?? {};
    insertCard.run(
      note.id + 1,
      note.id,
      DECK_ID,
      card.mod ?? 1599388703,
      card.usn ?? -1,
      card.type ?? 2,
      card.queue ?? 2,
      card.due ?? 100 + index,
      card.ivl ?? 21,
      card.reps ?? 4,
    );
  });

  const insertRevlog = db.prepare('INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, 2500, ?, ?)');
  for (const row of spec.revlog ?? []) {
    insertRevlog.run(row.id, row.cid, row.ease ?? 3, row.ivl ?? 10, row.lastIvl ?? 5, row.time ?? 4200, row.type ?? 1);
  }

  const collection = Buffer.from(db.serialize());
  db.close();

  const mediaMap = {};
  const members = [];
  let id = 0;
  for (const [name, contents] of Object.entries(spec.media ?? {})) {
    mediaMap[String(id)] = name;
    members.push({ name: String(id), data: Buffer.from(contents) });
    id += 1;
  }

  const entries = [];
  if (format === 'legacy2') {
    entries.push({ name: 'meta', data: Buffer.from([0x08, 0x02]) });
    entries.push({ name: 'collection.anki21', data: collection });
    entries.push({ name: 'collection.anki2', data: Buffer.from('legacy stub, not a database') });
  } else {
    entries.push({ name: 'collection.anki2', data: collection });
  }
  entries.push(...members);
  entries.push({ name: 'media', data: Buffer.from(JSON.stringify(mediaMap)) });
  writeZip(outPath, entries);
  return outPath;
}

module.exports = { buildPackage, DECK_ID, FIELD_SEPARATOR, NOTETYPE_ID };
