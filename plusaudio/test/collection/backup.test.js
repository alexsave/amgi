'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, tempDir } = require('./helpers/anki-python');
const { backupCollectionFile } = require('../../lib/collection/backup');
const { Collection } = require('../../lib/collection');

test('backupCollectionFile: copies into a sibling folder, one file per call', () => {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, 'fake collection bytes');

  const first = backupCollectionFile(collectionPath);
  const second = backupCollectionFile(collectionPath);

  assert.notEqual(first, second, 'two backups should not overwrite each other');
  assert.equal(fs.readFileSync(first, 'utf8'), 'fake collection bytes');
  assert.equal(fs.readFileSync(second, 'utf8'), 'fake collection bytes');
  assert.equal(path.dirname(first), path.join(dir, 'amgi-collection-backups'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'Collection: backs up once per session, before the first mutation, and the backup predates that mutation',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    const col = new Collection(collectionPath);

    // A read must not trigger a backup.
    col.listDecks();
    const backupsDir = path.join(dir, 'amgi-collection-backups');
    assert.equal(fs.existsSync(backupsDir), false, 'a read-only call must not back up anything');

    const created = col.createDeck('First Mutation');
    assert.equal(fs.readdirSync(backupsDir).length, 1);

    const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
    col.addNote({ deckId: created.result.deck.id, notetypeId: basic.id, fields: ['a', 'b'] });
    col.createDeck('Second Mutation');
    assert.equal(fs.readdirSync(backupsDir).length, 1, 'later mutations in the same session must not back up again');

    // The backup is a raw file copy taken before the *first* mutation, so it
    // should not contain the deck name that mutation went on to create.
    const backupPath = path.join(backupsDir, fs.readdirSync(backupsDir)[0]);
    const backupText = fs.readFileSync(backupPath, 'latin1');
    assert.ok(!backupText.includes('First Mutation'));

    fs.rmSync(dir, { recursive: true, force: true });
  },
);
