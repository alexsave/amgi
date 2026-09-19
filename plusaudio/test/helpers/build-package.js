'use strict';

// Build a small .apkg, so the tests exercise the real reader and writer without
// carrying a 20 MB deck in the repository.
//
// All three layouts Anki writes are covered: the two legacy ones, whose
// collection is a schema 11 database and whose media map is JSON, and the
// modern one, whose collection is a zstd-compressed schema 18 database and
// whose media map is a zstd-compressed protobuf.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const { writeZip } = require('../../lib/zip');

const SCHEMA_11 = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null, usn integer not null,
  ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
`;

// The tables notes, cards and revlog are the same in both schemas, which is why
// everything this tool does to a note works unchanged in either.
const SHARED_TABLES = `
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
CREATE INDEX ix_notes_csum on notes (csum);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_revlog_cid on revlog (cid);
`;

// Anki's schema 18, copied from a collection exported by Anki 26.09.2, minus
// its comments and the statistics tables ANALYZE leaves behind. The parts that
// matter to a reader are that note types, fields and decks live in tables
// rather than in JSON blobs in `col`, and that the name columns are declared
// COLLATE unicase.
const SCHEMA_18 = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
  scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL,
  ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL,
  dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE deck_config (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE unicase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL);
CREATE TABLE config (KEY text NOT NULL PRIMARY KEY, usn integer NOT NULL,
  mtime_secs integer NOT NULL, val blob NOT NULL) without rowid;
CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE unicase,
  config blob NOT NULL, PRIMARY KEY (ntid, ord)) without rowid;
CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);
CREATE TABLE templates (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE unicase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL,
  PRIMARY KEY (ntid, ord)) without rowid;
CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
CREATE INDEX idx_templates_usn ON templates (usn);
CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE unicase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL);
CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
CREATE INDEX idx_notetypes_usn ON notetypes (usn);
CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE unicase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, common blob NOT NULL, kind blob NOT NULL);
CREATE UNIQUE INDEX idx_decks_name ON decks (name);
CREATE TABLE tags (tag text NOT NULL PRIMARY KEY COLLATE unicase, usn integer NOT NULL,
  collapsed boolean NOT NULL, config blob NULL) without rowid;
CREATE TABLE graves (oid integer NOT NULL, type integer NOT NULL, usn integer NOT NULL,
  PRIMARY KEY (oid, type)) WITHOUT ROWID;
`;

const NOTETYPE_ID = 1536343392138;
const DECK_ID = 1547243929876;
const FIELD_NAMES = ['Korean', 'Audio', 'Sort'];
const SORT_FIELD_INDEX = 2;
const DECK_NAME = "Korean::문장::1. Retro's Beginner Grammar Sentences";

const MODELS = {
  [NOTETYPE_ID]: {
    id: NOTETYPE_ID,
    name: "Retro's sentences",
    type: 0,
    sortf: SORT_FIELD_INDEX,
    did: DECK_ID,
    flds: FIELD_NAMES.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20 })),
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
    name: DECK_NAME,
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

// Notetype.Config (proto/anki/notetypes.proto) carrying nothing but
// sort_field_idx, which is field 2: the one thing this tool reads out of it.
const NOTETYPE_CONFIG = Buffer.from([0x10, SORT_FIELD_INDEX]);

function insertNotesAndCards(db, spec) {
  const insertNote = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')");
  const insertCard = db.prepare("INSERT INTO cards VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 2500, ?, 0, 0, 0, 0, 0, '')");
  spec.notes.forEach((note, index) => {
    insertNote.run(
      note.id,
      note.guid,
      NOTETYPE_ID,
      note.mod,
      note.usn ?? 100,
      note.tags ?? ' Beginner ',
      note.fields.join(FIELD_SEPARATOR),
      note.fields[SORT_FIELD_INDEX] ?? '',
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
}

// Built on disk and read back, like the schema 18 fixture below, rather than
// in memory and serialized out: DatabaseSync.serialize() only exists on very
// recent Node, and nothing else here needs a runtime that new.
function buildSchema11Collection(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plusaudio-fixture-'));
  const dbPath = path.join(dir, 'collection.anki2');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_11 + SHARED_TABLES);
    db.prepare(
      'INSERT INTO col VALUES (1, 1536289200, 1599388703765, 1599388703000, 11, 0, 0, 0, ?, ?, ?, ?, ?)',
    ).run('{"schedVer": 2}', JSON.stringify(MODELS), JSON.stringify(DECKS), '{}', '{}');
    insertNotesAndCards(db, spec);
    db.close();
    return fs.readFileSync(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function schemaStatements(schema) {
  return schema
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((sql) => ({ sql, name: /CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/.exec(sql)[1] }));
}

/**
 * A schema 18 collection, with the metadata tables a modern package carries.
 *
 * It has to be built on disk: node:sqlite cannot register Anki's `unicase`
 * collation, so SQLite rejects a CREATE TABLE that names one, and a database
 * that does name one cannot be opened as an in-memory copy at all. The tables
 * are created without the collation, filled, and then the declarations are put
 * back by rewriting sqlite_master - which is only possible against a file - so
 * that the fixture presents a reader with exactly the obstacle a real modern
 * package does.
 *
 * The indexes are therefore in binary rather than unicase order. Nothing here
 * reads them in order, and the names in the fixture sort the same either way.
 */
function buildSchema18Collection(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plusaudio-fixture-'));
  const dbPath = path.join(dir, 'collection.anki21b');
  try {
    const db = new DatabaseSync(dbPath);
    const statements = schemaStatements(SCHEMA_18 + SHARED_TABLES);
    for (const { sql } of statements) db.exec(sql.replace(/ COLLATE unicase/g, ''));

    // Schema 18 leaves the legacy JSON columns in `col` empty; the metadata
    // moved into tables of its own.
    db.exec(
      "INSERT INTO col VALUES (1, 1536289200, 1599388703765, 1599388703000, 18, 0, 0, 0, '', '', '', '', '')",
    );
    db.prepare('INSERT INTO notetypes VALUES (?, ?, ?, -1, ?)').run(
      NOTETYPE_ID,
      MODELS[NOTETYPE_ID].name,
      MODELS[NOTETYPE_ID].mod,
      NOTETYPE_CONFIG,
    );
    const insertField = db.prepare("INSERT INTO fields VALUES (?, ?, ?, x'')");
    FIELD_NAMES.forEach((name, ord) => insertField.run(NOTETYPE_ID, ord, name));
    db.prepare("INSERT INTO templates VALUES (?, 0, 'Card 1', ?, -1, x'')").run(NOTETYPE_ID, MODELS[NOTETYPE_ID].mod);
    const insertDeck = db.prepare("INSERT INTO decks VALUES (?, ?, ?, -1, x'', x'')");
    insertDeck.run(1, 'Default', 0);
    // Schema 18 separates the components of a deck name with \x1f rather than
    // the "::" schema 11 uses.
    insertDeck.run(DECK_ID, DECK_NAME.replaceAll('::', '\x1f'), 1547243929);
    db.prepare("INSERT INTO deck_config VALUES (1, 'Default', 0, -1, x'')").run();

    insertNotesAndCards(db, spec);

    db.enableDefensive(false);
    db.exec('PRAGMA writable_schema = ON');
    const restore = db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?');
    for (const { sql, name } of statements) {
      if (sql.includes('COLLATE unicase')) restore.run(sql, name);
    }
    db.exec('PRAGMA writable_schema = RESET');
    db.close();
    return fs.readFileSync(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function varint(value) {
  const bytes = [];
  let rest = value;
  do {
    bytes.push(rest > 127 ? (rest & 0x7f) | 0x80 : rest);
    rest = Math.floor(rest / 128);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/**
 * One MediaEntries.MediaEntry, written by hand rather than with lib/protobuf.js
 * so that the fixture does not lean on the encoder it exists to exercise:
 * name (field 1), size (field 2) and sha1 (field 3), wrapped as a
 * length-delimited field 1 of the enclosing MediaEntries.
 */
function mediaEntryMessage(name, data) {
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.concat([
    Buffer.from([0x0a]),
    varint(nameBytes.length),
    nameBytes,
    Buffer.from([0x10]),
    varint(data.length),
    Buffer.from([0x1a, 20]),
    crypto.createHash('sha1').update(data).digest(),
  ]);
  return Buffer.concat([Buffer.from([0x0a]), varint(body.length), body]);
}

/**
 * @param {object} spec
 * @param {Array<{id, guid, fields: string[], mod, tags?}>} spec.notes
 * @param {Array<object>} [spec.revlog]
 * @param {object} [spec.media]   Anki filename -> contents
 * @param {'legacy1'|'legacy2'|'modern'} [spec.format]
 */
function buildPackage(outPath, spec) {
  const format = spec.format ?? 'legacy1';
  const media = Object.entries(spec.media ?? {}).map(([name, contents]) => [name, Buffer.from(contents)]);
  const entries = [];

  if (format === 'modern') {
    // Every member of a modern package is stored rather than deflated: the
    // collection, the media map and each media file are zstd-compressed
    // already, and the stub and `meta` are too small to be worth it.
    entries.push({ name: 'meta', data: Buffer.from([0x08, 0x03]), store: true });
    entries.push({
      name: 'collection.anki21b',
      data: zlib.zstdCompressSync(buildSchema18Collection(spec)),
      store: true,
    });
    entries.push({ name: 'collection.anki2', data: Buffer.from('legacy stub, not a database'), store: true });
    media.forEach(([, data], index) => {
      entries.push({ name: String(index), data: zlib.zstdCompressSync(data), store: true });
    });
    entries.push({
      name: 'media',
      data: zlib.zstdCompressSync(Buffer.concat(media.map(([name, data]) => mediaEntryMessage(name, data)))),
      store: true,
    });
    writeZip(outPath, entries);
    return outPath;
  }

  const collection = buildSchema11Collection(spec);
  const mediaMap = {};
  const members = [];
  media.forEach(([name, data], index) => {
    mediaMap[String(index)] = name;
    members.push({ name: String(index), data });
  });

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
