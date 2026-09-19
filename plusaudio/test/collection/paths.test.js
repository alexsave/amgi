'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { defaultBaseDir, listProfiles } = require('../../lib/collection/paths');

test('defaultBaseDir: the three platforms Anki documents (docs.ankiweb.net/files.html)', () => {
  const env = {};
  assert.equal(
    defaultBaseDir('darwin', env, '/Users/alex'),
    '/Users/alex/Library/Application Support/Anki2',
  );
  assert.equal(defaultBaseDir('win32', { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' }, 'C:\\Users\\alex'),
    path.join('C:\\Users\\alex\\AppData\\Roaming', 'Anki2'));
  assert.equal(defaultBaseDir('linux', env, '/home/alex'), '/home/alex/.local/share/Anki2');
  assert.equal(
    defaultBaseDir('linux', { XDG_DATA_HOME: '/custom/data' }, '/home/alex'),
    path.join('/custom/data', 'Anki2'),
  );
});

test('listProfiles: only subdirectories with a collection.anki2 count as profiles', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anki2-base-'));
  try {
    fs.mkdirSync(path.join(base, 'User 1'));
    fs.writeFileSync(path.join(base, 'User 1', 'collection.anki2'), '');
    fs.mkdirSync(path.join(base, 'User 2 (imported)'));
    fs.writeFileSync(path.join(base, 'User 2 (imported)', 'collection.anki2'), '');
    fs.mkdirSync(path.join(base, 'addons21'));
    fs.writeFileSync(path.join(base, 'prefs21.db'), '');

    const profiles = listProfiles(base);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['User 1', 'User 2 (imported)'],
    );
    assert.equal(profiles[0].collectionPath, path.join(base, 'User 1', 'collection.anki2'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listProfiles: a missing base folder is zero profiles, not an error', () => {
  assert.deepEqual(listProfiles('/no/such/anki2/base/folder'), []);
});
