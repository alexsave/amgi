'use strict';

// Proves the two halves of the lock story against a real Anki-shaped lock,
// not a simulation of SQLITE_BUSY: that this package reports 'locked' (fast,
// no hang, no retry) while a real Anki-library connection holds the file, and
// that this package never leaves the file in a state where Anki's own open
// fails afterwards.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, holdCollectionOpen, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { openCollection } = require('../../lib/collection/open');
const { Collection } = require('../../lib/collection');

test('openCollection: a path with nothing there', () => {
  assert.equal(openCollection('/no/such/collection.anki2').status, 'not-found');
});

test(
  'openCollection reports "locked" immediately while the real Anki library holds the file, with no lingering handle afterwards',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  async () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);

    const holder = holdCollectionOpen(collectionPath);
    await holder.held;

    const start = Date.now();
    const result = openCollection(collectionPath);
    const elapsedMs = Date.now() - start;

    assert.equal(result.status, 'locked');
    // Zero busy timeout: this must fail near-instantly, not after any kind
    // of retry/backoff window. 2s of slack for process scheduling noise.
    assert.ok(elapsedMs < 2000, `openCollection took ${elapsedMs}ms while locked; expected a fast failure`);

    await holder.release();

    // The reverse hazard: after this package's failed open (and, separately,
    // after a real one), it must never hold a handle that stops Anki itself
    // from reopening the same file.
    const reopened = openCollection(collectionPath);
    assert.equal(reopened.status, 'ok');
    reopened.close();

    // And a real Anki-library open right after that, too.
    withAnkiLibrary(collectionPath, 'assert(True)');

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test(
  'Collection methods never leave a handle open: every call can be followed immediately by a real Anki open',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);

    const col = new Collection(collectionPath);
    col.listDecks();
    withAnkiLibrary(collectionPath, 'pass');
    col.listNotetypes();
    withAnkiLibrary(collectionPath, 'pass');
    const deck = col.createDeck('Handle Lifetime Test');
    withAnkiLibrary(collectionPath, 'pass');
    const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
    col.addNote({ deckId: deck.result.deck.id, notetypeId: basic.id, fields: ['a', 'b'] });
    withAnkiLibrary(collectionPath, 'pass');
    col.addMedia('clip.mp3', Buffer.from('data'));
    withAnkiLibrary(collectionPath, 'pass');

    fs.rmSync(dir, { recursive: true, force: true });
  },
);
