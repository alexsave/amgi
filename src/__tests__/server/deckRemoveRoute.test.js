// GET and DELETE /api/anki/decks/:id end to end against a real collection file (the direct
// transport): what the confirmation is told, the delete itself, the Default deck refused, a deck
// already gone answering 404 with the sentence the page shows, and Anki holding the file answering
// 409 locked as every other route does. The rows a delete leaves are proved against Anki itself in
// plusaudio/test/collection/deck-remove.test.js; this is the HTTP surface over it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANSWER } from '../../server/anki/answer';
import { DELETE, GET } from '../../server/api/anki/decks/[id]/route';

const require = createRequire(import.meta.url);
const { anki, buildFixtureCollection, holdCollectionOpen, withAnkiLibrary } = require('../../../plusaudio/test/collection/helpers/anki-python');

const maybe = anki ? test : test.skip;

function call(handler, method, collectionPath, id) {
  const request = new Request(`http://localhost/api/anki/decks/${id}`, {
    method,
    headers: { 'x-amgi-collection': encodeURIComponent(collectionPath) },
  });
  return handler(request, { params: Promise.resolve({ id: String(id) }) }).then((r) => ({ status: r.status, body: r[ANSWER] }));
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-deck-remove-route-'));
  const collectionPath = path.join(dir, 'collection.anki2');
  buildFixtureCollection(collectionPath); // "Existing" with one note, and "Existing::Child"
  const ids = withAnkiLibrary(collectionPath, 'print(col.decks.id("Existing", create=False), col.decks.id("Existing::Child", create=False))');
  const [parent, child] = ids.trim().split(' ').map(Number);
  return { dir, collectionPath, parent, child };
}

describe('/api/anki/decks/:id, GET and DELETE', () => {
  maybe('the summary, the delete, then 404 for the deck that went', async () => {
    const { dir, collectionPath, parent } = fixture();
    const summary = await call(GET, 'GET', collectionPath, parent);
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, { mode: 'direct', id: parent, name: 'Existing', subdecks: 1, cards: 1, notes: 1 });

    const removed = await call(DELETE, 'DELETE', collectionPath, parent);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { mode: 'direct', id: parent, name: 'Existing', decks: 2, cards: 1, notes: 1 });

    for (const [handler, method] of [[GET, 'GET'], [DELETE, 'DELETE']]) {
      const again = await call(handler, method, collectionPath, parent);
      assert.equal(again.status, 404, method);
      assert.equal(again.body.error, 'This deck no longer exists.');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  maybe('the Default deck is refused with the reason, and stays', async () => {
    const { dir, collectionPath } = fixture();
    const refused = await call(DELETE, 'DELETE', collectionPath, 1);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Default deck cannot be deleted/);
    assert.equal(withAnkiLibrary(collectionPath, 'print(col.decks.name(1))').trim(), 'Default');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  maybe('Anki holding the collection answers 409 locked, and nothing is deleted', async () => {
    const { dir, collectionPath, child } = fixture();
    const holder = holdCollectionOpen(collectionPath);
    await holder.held;
    try {
      const locked = await call(DELETE, 'DELETE', collectionPath, child);
      assert.equal(locked.status, 409);
      assert.equal(locked.body.mode, 'locked');
      assert.match(locked.body.error, /Anki is open on this collection/);
    } finally {
      await holder.release();
    }
    assert.equal((await call(GET, 'GET', collectionPath, child)).status, 200);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
