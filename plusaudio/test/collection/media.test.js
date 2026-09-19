'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { addMediaFile, mediaDirFor } = require('../../lib/collection/media');
const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');

test('mediaDirFor: derives collection.media from collection.anki2, same directory', () => {
  assert.equal(mediaDirFor('/profile/collection.anki2'), '/profile/collection.media');
});

test('addMediaFile: writing the same content under the same name is idempotent', () => {
  const dir = tempDir();
  const data = Buffer.from('clip contents');
  const first = addMediaFile(dir, 'clip.mp3', data);
  const second = addMediaFile(dir, 'clip.mp3', data);
  assert.equal(first, 'clip.mp3');
  assert.equal(second, 'clip.mp3');
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addMediaFile: a name collision with different content gets a hash suffix, not clobbered', () => {
  const dir = tempDir();
  const first = addMediaFile(dir, 'clip.mp3', Buffer.from('original'));
  const second = addMediaFile(dir, 'clip.mp3', Buffer.from('different content'));
  assert.equal(first, 'clip.mp3');
  assert.notEqual(second, 'clip.mp3');
  assert.match(second, /^clip-[0-9a-f]{40}\.mp3$/);
  assert.equal(fs.readFileSync(path.join(dir, 'clip.mp3'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(dir, second), 'utf8'), 'different content');
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'Collection.addMedia: a file dropped in the folder while Anki is closed is picked up by col.media.check() on reopen',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    const col = new Collection(collectionPath);

    const data = crypto.randomBytes(64);
    const filename = col.addMedia('new-clip.mp3', data);
    assert.equal(filename, 'new-clip.mp3');

    // Not referenced by any note yet, so col.media.check() should see it as
    // present and unused - proof that the folder write alone (no
    // collection.media.db2 row of our own) is enough for Anki to find it, as
    // documented in lib/collection/media.js.
    const report = withAnkiLibrary(collectionPath, 'print("MEDIA:", col.media.check())');
    assert.match(report, /unused.*new-clip\.mp3/is);
    assert.match(report, /missing files:.*0/is);

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test(
  'a note field that references the added media clip resolves cleanly (no missing, no unused)',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    const col = new Collection(collectionPath);
    const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
    const deck = col.createDeck('Media Test').result.deck;

    col.addMedia('referenced.mp3', Buffer.from('audio bytes'));
    col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['front', '[sound:referenced.mp3]'] });

    const report = withAnkiLibrary(collectionPath, 'print("MEDIA:", col.media.check())');
    assert.match(report, /missing files:.*0/is);
    assert.match(report, /unused files:.*0/is);

    fs.rmSync(dir, { recursive: true, force: true });
  },
);
