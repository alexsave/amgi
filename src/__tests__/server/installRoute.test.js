/**
 * @jest-environment node
 */

// POST /api/anki/install end to end: what the one button actually answers,
// against a real collection file. The note type is made by the route itself
// only when the collection can be written from here (Anki closed); otherwise
// the files still land and the answer says Anki has to be restarted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { POST } from '../../app/api/anki/install/route';
import { INSTALLED_MESSAGE, RESTART_MESSAGE } from '../../server/anki/install';

const { anki, buildFixtureCollection, holdCollectionOpen, tempDir } = require('../../../plusaudio/test/collection/helpers/anki-python');

const maybe = anki ? it : it.skip;

function post(settings, body = {}) {
  return POST(
    new Request('http://localhost/api/anki/install', {
      method: 'POST',
      headers: { 'x-amgi-anki-settings': JSON.stringify(settings), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function ankiBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-route-'));
  fs.mkdirSync(path.join(base, 'User 1'), { recursive: true });
  const collectionPath = path.join(base, 'User 1', 'collection.anki2');
  return { base, collectionPath };
}

describe('POST /api/anki/install', () => {
  it('installs the files and says to restart Anki when no collection is chosen', async () => {
    const { base } = ankiBase();
    const response = await post({ baseDirOverride: base });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(base, 'addons21', 'amgi_bridge', '__init__.py'))).toBe(true);
    expect(data).toMatchObject({ ok: true, notetypeCreated: false, needsRestart: true, message: RESTART_MESSAGE });
    fs.rmSync(base, { recursive: true, force: true });
  });

  maybe('also creates the note type when the collection is closed, so no restart is needed', async () => {
    const { base, collectionPath } = ankiBase();
    buildFixtureCollection(collectionPath);
    const response = await post({ baseDirOverride: base, collectionPath });
    const data = await response.json();
    expect(data).toMatchObject({ ok: true, notetypeCreated: true, needsRestart: false, message: INSTALLED_MESSAGE });
    expect(fs.existsSync(path.join(base, 'User 1', 'collection.media', '_amgi-loop.js'))).toBe(true);

    // Pressing it again is harmless: the note type is already there.
    const again = await (await post({ baseDirOverride: base, collectionPath })).json();
    expect(again).toMatchObject({ ok: true, notetypeCreated: false, needsRestart: false });
    fs.rmSync(base, { recursive: true, force: true });
  });

  maybe('falls back to "restart Anki" when Anki holds the collection open', async () => {
    const { base, collectionPath } = ankiBase();
    buildFixtureCollection(collectionPath);
    const holder = holdCollectionOpen(collectionPath);
    await holder.held;
    try {
      const data = await (await post({ baseDirOverride: base, collectionPath })).json();
      expect(data).toMatchObject({ ok: true, notetypeCreated: false, needsRestart: true, message: RESTART_MESSAGE });
      expect(fs.existsSync(path.join(base, 'addons21', 'amgi_mic', '__init__.py'))).toBe(true);
    } finally {
      await holder.release();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
});
