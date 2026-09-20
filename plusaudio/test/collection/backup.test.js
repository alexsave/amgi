'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const {
  BACKUP_KEEP_COUNT,
  BACKUP_MAX_AGE_MS,
  backupCollectionFile,
  ensureBackupBeforeChange,
  noteCollectionWritten,
  pruneBackups,
  resetBackupLedger,
} = require('../../lib/collection/backup');
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
  'Collection: backs up once per working period, before the first mutation, and the backup predates it',
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
    assert.equal(fs.readdirSync(backupsDir).length, 1, 'later mutations in the same period must not back up again');

    // The backup is a raw file copy taken before the *first* mutation, so it
    // should not contain the deck name that mutation went on to create.
    const backupPath = path.join(backupsDir, fs.readdirSync(backupsDir)[0]);
    const backupText = fs.readFileSync(backupPath, 'latin1');
    assert.ok(!backupText.includes('First Mutation'));

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// --- Retention ------------------------------------------------------------
//
// These delete files out of a folder that, in real life, sits in the user's
// Anki data directory - so the interesting assertions are not "the right files
// went" but "nothing else did".

/** Plant a file (or a directory, with `{ dir: true }`) in the backup folder and return its path. */
function plant(dir, name, { dir: asDir = false } = {}) {
  const backupsDir = path.join(dir, 'amgi-collection-backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const target = path.join(backupsDir, name);
  if (asDir) fs.mkdirSync(target, { recursive: true });
  else fs.writeFileSync(target, name);
  return target;
}

function stampFor(day) {
  return `2026-01-${String(day).padStart(2, '0')}T04-05-06-007Z`;
}

test('pruneBackups: keeps the newest BACKUP_KEEP_COUNT and deletes the rest', () => {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, 'fake collection bytes');

  const days = [];
  for (let day = 1; day <= BACKUP_KEEP_COUNT + 5; day += 1) {
    plant(dir, `collection.anki2.${stampFor(day)}.bak`);
    days.push(day);
  }

  const deleted = pruneBackups(collectionPath);
  assert.equal(deleted.length, 5);

  const left = fs.readdirSync(path.join(dir, 'amgi-collection-backups')).sort();
  assert.equal(left.length, BACKUP_KEEP_COUNT);
  // The five oldest went, by the timestamp in the name - not by mtime, which
  // is the same for all of them here since they were written back to back.
  assert.deepEqual(
    left,
    days.slice(5).map((day) => `collection.anki2.${stampFor(day)}.bak`),
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups: never deletes the most recent backup, even at keep=1 or a nonsense keep', () => {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, 'fake collection bytes');
  for (const day of [1, 2, 3]) plant(dir, `collection.anki2.${stampFor(day)}.bak`);

  pruneBackups(collectionPath, { keep: 0 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'amgi-collection-backups')), [
    `collection.anki2.${stampFor(3)}.bak`,
  ], 'keep=0 must still leave the newest - losing every backup is never the right answer');

  pruneBackups(collectionPath, { keep: 1 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'amgi-collection-backups')), [
    `collection.anki2.${stampFor(3)}.bak`,
  ]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups: touches nothing that does not match the naming convention exactly', () => {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, 'fake collection bytes');

  const survivors = [
    plant(dir, 'collection.anki2.bak'), // no timestamp at all
    plant(dir, 'collection.anki2.2026-13-45T04-05-06-007Z.bak'), // month 13, day 45
    plant(dir, 'collection.anki2.2026-02-30T04-05-06-007Z.bak'), // a date Date silently rolls over
    plant(dir, 'collection.anki2.2026-01-01T04-05-06-07Z.bak'), // two-digit milliseconds
    plant(dir, 'collection.anki2.2026-01-01T04-05-06-007Z.bak.txt'), // not a .bak
    plant(dir, 'notes.anki2.2026-01-01T04-05-06-007Z.bak'), // a different collection's
    plant(dir, 'old-collection.anki2.2026-01-01T04-05-06-007Z.bak'), // wrong prefix
    plant(dir, 'important-notes.txt'),
    plant(dir, `collection.anki2.${stampFor(9)}.bak`, { dir: true }), // right name, but a directory
  ];
  for (const day of [1, 2, 3]) plant(dir, `collection.anki2.${stampFor(day)}.bak`);

  pruneBackups(collectionPath, { keep: 1 });

  for (const survivor of survivors) {
    assert.ok(fs.existsSync(survivor), `${path.basename(survivor)} is not ours to delete`);
  }
  assert.equal(fs.existsSync(path.join(dir, 'amgi-collection-backups', `collection.anki2.${stampFor(1)}.bak`)), false);
  assert.ok(fs.existsSync(path.join(dir, 'amgi-collection-backups', `collection.anki2.${stampFor(3)}.bak`)));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupCollectionFile: prunes the folder it just added to', () => {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, 'fake collection bytes');
  for (let day = 1; day <= BACKUP_KEEP_COUNT + 3; day += 1) plant(dir, `collection.anki2.${stampFor(day)}.bak`);

  const fresh = backupCollectionFile(collectionPath);

  const left = fs.readdirSync(path.join(dir, 'amgi-collection-backups'));
  assert.equal(left.length, BACKUP_KEEP_COUNT);
  assert.ok(left.includes(path.basename(fresh)), 'the backup just taken must survive its own pruning');

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- The once-per-working-period gate -------------------------------------
//
// The gate compares a "mark" read out of the collection (backup.js's
// readCollectionMark - col.mod and friends). These tests hand it marks
// directly, so the policy can be exercised without a real Anki collection and
// without sleeping; the Collection-level test below is what proves the mark
// really does move when Anki writes.

/** How many backups are sitting next to the collection in `dir` right now. */
function backupCount(dir) {
  const backupsDir = path.join(dir, 'amgi-collection-backups');
  return fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
}

function stubCollection(dir = tempDir(), contents = 'fake collection bytes') {
  const collectionPath = path.join(dir, 'collection.anki2');
  fs.writeFileSync(collectionPath, contents);
  return { dir, collectionPath };
}

test('ensureBackupBeforeChange: copies once for a working period, not once per call', () => {
  resetBackupLedger();
  const { dir, collectionPath } = stubCollection();
  const now = Date.parse('2026-01-01T09:00:00Z');

  assert.ok(
    ensureBackupBeforeChange(collectionPath, { now, mark: 'mark-0' }),
    'the first change of a period must be backed up',
  );
  assert.equal(backupCount(dir), 1);

  // The caller writes, and says so. Every later change in the period rides on
  // the backup already taken - this is the whole point of the fix.
  for (let i = 0; i < 5; i += 1) {
    noteCollectionWritten(collectionPath, { mark: `mark-${i + 1}` });
    assert.equal(
      ensureBackupBeforeChange(collectionPath, { now: now + i * 1000, mark: `mark-${i + 1}` }),
      null,
      'our own write must not look like somebody else having changed the collection',
    );
  }
  assert.equal(backupCount(dir), 1, 'a whole period of our own edits is one copy');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureBackupBeforeChange: an edit we did not make starts a new period', () => {
  resetBackupLedger();
  const { dir, collectionPath } = stubCollection();
  const now = Date.parse('2026-01-01T09:00:00Z');

  ensureBackupBeforeChange(collectionPath, { now, mark: 'ours-before' });
  noteCollectionWritten(collectionPath, { mark: 'ours-after' });
  assert.equal(ensureBackupBeforeChange(collectionPath, { now, mark: 'ours-after' }), null);

  // Anki (or a sync, or a restore) writes to the collection behind our back.
  // That work is in nobody's backup, so the next change must not be made on
  // top of it uncovered.
  fs.writeFileSync(collectionPath, 'a study session happened in Anki');

  assert.ok(ensureBackupBeforeChange(collectionPath, { now: now + 1000, mark: 'anki-was-here' }));
  assert.equal(backupCount(dir), 2);
  const newest = fs.readdirSync(path.join(dir, 'amgi-collection-backups')).sort().at(-1);
  assert.equal(
    fs.readFileSync(path.join(dir, 'amgi-collection-backups', newest), 'utf8'),
    'a study session happened in Anki',
    "the new backup must hold the other process's work, not ours",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureBackupBeforeChange: a backup older than BACKUP_MAX_AGE_MS is refreshed', () => {
  resetBackupLedger();
  const { dir, collectionPath } = stubCollection();
  const now = Date.parse('2026-01-01T09:00:00Z');

  ensureBackupBeforeChange(collectionPath, { now, mark: 'mark-0' });
  assert.equal(ensureBackupBeforeChange(collectionPath, { now: now + BACKUP_MAX_AGE_MS - 1, mark: 'mark-0' }), null);
  assert.equal(backupCount(dir), 1);

  // A long run of our own edits must not all sit behind one backup from hours
  // ago, however sure we are that nobody else touched the file.
  assert.ok(ensureBackupBeforeChange(collectionPath, { now: now + BACKUP_MAX_AGE_MS, mark: 'mark-0' }));
  assert.equal(backupCount(dir), 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureBackupBeforeChange: an unreadable collection does not get copied on top of a recent backup', () => {
  resetBackupLedger();
  const { dir, collectionPath } = stubCollection();
  const now = Date.parse('2026-01-01T09:00:00Z');

  ensureBackupBeforeChange(collectionPath, { now, mark: 'mark-0' });
  // mark === null means Anki holds the lock (only addMedia can get this far).
  // A copy taken now would be the torn, WAL-inconsistent file Anki's manual
  // warns about, and there is a fresh backup already.
  assert.equal(ensureBackupBeforeChange(collectionPath, { now: now + 1000, mark: null }), null);
  assert.equal(backupCount(dir), 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureBackupBeforeChange: two collections keep separate ledgers', () => {
  resetBackupLedger();
  const root = tempDir();
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  fs.mkdirSync(one);
  fs.mkdirSync(two);
  const first = stubCollection(one, 'profile one').collectionPath;
  const second = stubCollection(two, 'profile two').collectionPath;
  const now = Date.parse('2026-01-01T09:00:00Z');

  assert.ok(ensureBackupBeforeChange(first, { now, mark: 'shared-looking-mark' }));
  // Switching profiles must not inherit the other profile's "already backed
  // up": it is a different file, and nothing has ever copied it - even if its
  // mark happens to read the same.
  assert.ok(ensureBackupBeforeChange(second, { now, mark: 'shared-looking-mark' }));
  assert.equal(backupCount(one), 1);
  assert.equal(backupCount(two), 1);

  // ...and the same collection spelled two ways is still one collection.
  const noisySpelling = path.join(one, '.', '..', 'one', 'collection.anki2');
  assert.equal(ensureBackupBeforeChange(noisySpelling, { now, mark: 'shared-looking-mark' }), null);
  assert.equal(backupCount(one), 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'Collection: an external write between two mutations gets its own backup',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    resetBackupLedger();
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    const backupsDir = path.join(dir, 'amgi-collection-backups');

    new Collection(collectionPath).createDeck('Before');
    assert.equal(fs.readdirSync(backupsDir).length, 1);
    // A second Collection object is not a second session: per-request callers
    // (src/server/anki/transport.js) build one of these every request.
    new Collection(collectionPath).createDeck('Still The Same Period');
    assert.equal(fs.readdirSync(backupsDir).length, 1, 'a fresh Collection must not mean a fresh copy');

    // Now the user opens Anki and does some work of their own.
    withAnkiLibrary(collectionPath, 'col.decks.id("Made In Anki")');

    new Collection(collectionPath).createDeck('After');
    assert.equal(fs.readdirSync(backupsDir).length, 2);
    const newest = fs.readdirSync(backupsDir).sort().at(-1);
    const backupText = fs.readFileSync(path.join(backupsDir, newest), 'latin1');
    assert.ok(backupText.includes('Made In Anki'), "the second backup must contain Anki's own work");
    assert.ok(!backupText.includes('After'), 'and must predate the mutation it was taken for');

    fs.rmSync(dir, { recursive: true, force: true });
  },
);
