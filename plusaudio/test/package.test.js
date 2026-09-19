'use strict';

// The package layer: the three layouts Anki writes, and the promise that a
// package comes out in the layout it went in as, with everything this tool did
// not set out to change carried through untouched.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { after, before, describe, it } = require('node:test');

const { augmentPackage } = require('../lib/augment');
const { openPackage, writePackage, UnsupportedPackageError } = require('../lib/package');
const { readZip, writeZip } = require('../lib/zip');
const { buildPackage } = require('./helpers/build-package');
const { inspectPackage } = require('./helpers/inspect');

const NOW_RUN_1 = 1_760_000_000;
const NOW_RUN_2 = 1_770_000_000;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const NOTES = [
  {
    id: 1547294175188,
    guid: 'emxr}cj7`a',
    mod: 1597946183,
    fields: ['<div><b>안녕하세요</b>?</div>', '', '1-1-13-1'],
  },
  {
    id: 1547294381723,
    guid: 'b4rOY?JJT7',
    mod: 1597946185,
    fields: ['질문 <b>있습니까</b>?', '[sound:1-1-13-2.mp3]<img src="pic.jpg">', '1-1-13-2'],
  },
];

const REVLOG = [
  { id: 1500000000000, cid: 1547294175189 },
  { id: 1500000600000, cid: 1547294381724 },
];

let dir;

function makeSource(name, overrides = {}) {
  const target = path.join(dir, name);
  buildPackage(target, {
    notes: NOTES,
    revlog: REVLOG,
    media: { 'pic.jpg': 'JPEGDATA', '1-1-13-2.mp3': 'MP3DATA' },
    ...overrides,
  });
  return target;
}

function members(filePath) {
  return new Map(readZip(filePath).map((entry) => [entry.name, entry]));
}

async function run(inputPath, outputPath, options = {}) {
  const calls = [];
  const summary = await augmentPackage({
    inputPath,
    outputPath,
    generate: async ({ text }) => {
      calls.push(text);
      return Buffer.from(`clip:${crypto.createHash('sha1').update(text).digest('hex')}`);
    },
    now: NOW_RUN_1,
    ...options,
  });
  return { summary, calls };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plusaudio-package-test-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('modern packages', () => {
  it('reads one, and writes one back in the same layout', async () => {
    const input = makeSource('modern.apkg', { format: 'modern' });
    const output = path.join(dir, 'modern-out.apkg');
    const { summary } = await run(input, output);

    assert.equal(summary.format, 'modern');
    assert.equal(summary.notesChanged, 2);
    assert.equal(summary.audioGenerated, 2);

    const out = members(output);
    assert.deepEqual(out.get('meta').data(), Buffer.from([0x08, 0x03]), 'meta must still say version 3');
    assert.ok(out.has('collection.anki21b'), 'the collection must still be the modern member');
    assert.ok(!out.has('collection.anki21'), 'no legacy database may appear');
    assert.deepEqual(
      out.get('collection.anki21b').data().subarray(0, 4),
      ZSTD_MAGIC,
      'the collection must still be zstd-compressed',
    );
    assert.deepEqual(out.get('media').data().subarray(0, 4), ZSTD_MAGIC, 'the media map must be zstd-compressed');

    const result = inspectPackage(output);
    assert.equal(result.format, 'modern');
    assert.equal(result.schemaVersion, 18);
    assert.equal(result.mediaNames.size, 4, '2 original files plus 2 generated clips');
  });

  it('does not upgrade a legacy package on the way out', async () => {
    const input = makeSource('stays-legacy.apkg');
    const output = path.join(dir, 'stays-legacy-out.apkg');
    const { summary } = await run(input, output);

    assert.equal(summary.format, 'legacy1');
    const out = members(output);
    assert.ok(!out.has('collection.anki21b'), 'a legacy package must not grow a modern collection');
    assert.ok(out.has('collection.anki2'));
    assert.equal(typeof JSON.parse(out.get('media').data().toString('utf8')), 'object');
  });

  it('changes nothing about a note but the field it wrote', async () => {
    const input = makeSource('modern-identity.apkg', { format: 'modern' });
    const output = path.join(dir, 'modern-identity-out.apkg');
    await run(input, output);

    const before = inspectPackage(input);
    const after_ = inspectPackage(output);

    assert.deepEqual(after_.guids, before.guids, 'note guids must be preserved');
    assert.deepEqual(after_.notes.map((n) => n.id), before.notes.map((n) => n.id));
    assert.deepEqual(after_.notes.map((n) => n.mid), before.notes.map((n) => n.mid));
    assert.deepEqual(after_.cards.map((c) => c.id), before.cards.map((c) => c.id));
    assert.equal(after_.cardsDigest, before.cardsDigest, 'cards and their scheduling must be untouched');
    assert.equal(after_.revlogDigest, before.revlogDigest, 'revlog must be byte-identical');
    assert.equal(after_.revlog.length, 2);
    assert.deepEqual(after_.decks, before.decks, 'deck ids and names must be untouched');
    assert.deepEqual(after_.notetypes, before.notetypes, 'note types and their fields must be untouched');
    assert.equal(after_.col.crt, before.col.crt);

    for (const note of after_.notes) {
      const original = before.notes.find((n) => n.id === note.id);
      assert.equal(note.mod, note.flds === original.flds ? original.mod : NOW_RUN_1);
    }
  });

  it('carries every member it did not set out to change through byte for byte', async () => {
    const input = makeSource('modern-passthrough.apkg', { format: 'modern' });
    const output = path.join(dir, 'modern-passthrough-out.apkg');
    await run(input, output);

    const source = members(input);
    const out = members(output);
    // The two media files the deck came with, the legacy stub and `meta`: the
    // compressed bytes, not just the contents, so a member that was rewritten
    // with a different compressor would be caught.
    for (const name of ['meta', 'collection.anki2', '0', '1']) {
      assert.deepEqual(out.get(name).data(), source.get(name).data(), `${name} must be carried through`);
      assert.equal(out.get(name).method, source.get(name).method, `${name} must be stored the same way`);
    }

    // And the media map's entries for those files, which have to keep their
    // index or the files they name move out from under them.
    const before = openPackage(input);
    const after_ = openPackage(output);
    try {
      assert.equal(after_.mediaEntries.length, before.mediaEntries.length + 2);
      before.mediaEntries.forEach((entry, index) => {
        assert.deepEqual(after_.mediaEntries[index].raw, entry.raw, `entry ${index} must be untouched`);
      });
    } finally {
      before.close();
      after_.close();
    }
  });

  it('describes an added clip the way Anki would', async () => {
    const input = makeSource('modern-added.apkg', { format: 'modern' });
    const output = path.join(dir, 'modern-added-out.apkg');
    await run(input, output);

    const pkg = openPackage(output);
    try {
      const added = pkg.mediaEntries.filter((entry) => entry.name.startsWith('plusaudio-'));
      assert.equal(added.length, 2);
      for (const entry of added) {
        const index = pkg.mediaEntries.indexOf(entry);
        const member = members(output).get(String(index));
        assert.deepEqual(member.data().subarray(0, 4), ZSTD_MAGIC, 'a media file must be zstd-compressed');
        assert.equal(member.method, 0, 'and stored rather than deflated as well');

        const contents = zlib.zstdDecompressSync(member.data());
        assert.equal(entry.size, contents.length, 'size describes the file, not the compressed member');
        assert.deepEqual(entry.sha1, crypto.createHash('sha1').update(contents).digest());
      }
    } finally {
      pkg.close();
    }
  });

  it('is a no-op when re-run on its own output', async () => {
    const input = makeSource('modern-idempotent.apkg', { format: 'modern' });
    const first = path.join(dir, 'modern-idempotent-1.apkg');
    const second = path.join(dir, 'modern-idempotent-2.apkg');

    await run(input, first);
    const { summary, calls } = await run(first, second, { now: NOW_RUN_2 });

    assert.equal(summary.notesChanged, 0);
    assert.equal(calls.length, 0);
    assert.equal(summary.audioUpToDate, 2);
    assert.deepEqual(
      fs.readFileSync(second),
      fs.readFileSync(first),
      're-running on the output must reproduce it byte for byte',
    );
  });

  it('converts between the two reference forms without regenerating a clip', async () => {
    const input = makeSource('modern-convert.apkg', { format: 'modern' });
    const sound = path.join(dir, 'modern-convert-sound.apkg');
    const html = path.join(dir, 'modern-convert-html.apkg');
    const again = path.join(dir, 'modern-convert-html-2.apkg');

    await run(input, sound);
    const forward = await run(sound, html, { audioTag: 'html', now: NOW_RUN_2 });
    assert.equal(forward.calls.length, 0, 'switching form must not regenerate audio');
    assert.equal(forward.summary.mediaAdded, 0);
    assert.equal(forward.summary.notesChanged, 2);

    const converted = inspectPackage(html);
    assert.equal(converted.mediaNames.size, 4, 'no clip is added or dropped by the conversion');
    for (const note of converted.notes) {
      const audioField = note.flds.split('\x1f')[1];
      assert.ok(!/\[sound:plusaudio-/.test(audioField), 'the sound tag must be gone, not kept alongside');
      assert.match(audioField, /<audio src="plusaudio-[0-9a-f]{20}\.mp3"><\/audio>/);
    }

    const stable = await run(html, again, { audioTag: 'html', now: NOW_RUN_2 });
    assert.equal(stable.summary.notesChanged, 0);
    assert.deepEqual(fs.readFileSync(again), fs.readFileSync(html));
  });

  it('regenerates a clip whose media file has gone missing from the package', async () => {
    const input = makeSource('modern-dangling.apkg', { format: 'modern' });
    const first = path.join(dir, 'modern-dangling-1.apkg');
    await run(input, first);

    // Drop one generated clip's member but leave its entry in the media map.
    const pkg = openPackage(first);
    const lost = pkg.mediaEntries.findIndex((entry) => entry.name.startsWith('plusaudio-'));
    pkg.close();
    const broken = path.join(dir, 'modern-dangling-broken.apkg');
    writeZip(
      broken,
      readZip(first)
        .filter((entry) => entry.name !== String(lost))
        .map((entry) => ({ name: entry.name, data: entry.data(), store: entry.method === 0 })),
    );

    const repaired = path.join(dir, 'modern-dangling-2.apkg');
    const { summary, calls } = await run(broken, repaired, { now: NOW_RUN_2 });
    assert.equal(calls.length, 1, 'only the missing clip is regenerated');
    assert.equal(summary.notesChanged, 0, 'the note already said the right thing');

    const fixed = openPackage(repaired);
    try {
      const entry = fixed.mediaEntries[lost];
      const contents = zlib.zstdDecompressSync(members(repaired).get(String(lost)).data());
      assert.equal(entry.size, contents.length);
      assert.deepEqual(entry.sha1, crypto.createHash('sha1').update(contents).digest());
      assert.equal(fixed.mediaEntries.length, 4, 'the entry is rewritten in place, not appended');
    } finally {
      fixed.close();
    }
  });

  it('refuses a package whose collection is not compressed the way its version says', async () => {
    const input = path.join(dir, 'not-really-modern.apkg');
    writeZip(input, [
      { name: 'meta', data: Buffer.from([0x08, 0x03]) },
      { name: 'collection.anki21b', data: Buffer.from('SQLite format 3\0not zstd at all') },
    ]);

    await assert.rejects(
      () => run(input, path.join(dir, 'not-really-modern-out.apkg')),
      (error) => error instanceof UnsupportedPackageError && /not zstd-compressed/.test(error.message),
    );
  });
});

describe('the modern media map', () => {
  // A MediaEntries message for two files, serialised by Anki's own protobuf
  // implementation (anki 26.09.2, python). Pinning the bytes is what keeps the
  // hand-rolled codec in lib/protobuf.js honest.
  const ANKI_ENCODED =
    '0a210a077069632e6a706710081a14f730ca5b2432cec8c7ace3a41bb17ea21e34f2c8' +
    '0a3d0a22706c7573617564696f2d30313233343536373839616263646566303132332e6d703310ac02' +
    '1a1402fd68253071f895718c8d41f7ff665abe1a6290';
  const CLIP_NAME = 'plusaudio-0123456789abcdef0123.mp3';
  const CLIP = Buffer.alloc(300, 'x');

  it('decodes what Anki encodes', () => {
    const input = path.join(dir, 'golden-in.apkg');
    buildPackage(input, { notes: NOTES, media: { 'pic.jpg': 'JPEGDATA' }, format: 'modern' });

    const pkg = openPackage(input);
    try {
      assert.deepEqual(pkg.mediaMap, { 0: 'pic.jpg' });
      assert.equal(pkg.mediaEntries[0].size, 8);
      assert.deepEqual(
        pkg.mediaEntries[0].sha1,
        crypto.createHash('sha1').update('JPEGDATA').digest(),
        'the sha1 is of the file, not of the member',
      );
    } finally {
      pkg.close();
    }
  });

  it('writes what the caller committed, even in WAL mode', () => {
    // The collection is read back off disk rather than serialized out of
    // SQLite, so anything still sitting in a write-ahead log would be missing
    // from the package. Anki's own exports use the rollback journal, but the
    // guarantee must not depend on that.
    const input = path.join(dir, 'wal-in.apkg');
    buildPackage(input, { notes: NOTES, media: { 'pic.jpg': 'JPEGDATA' }, format: 'modern' });
    const output = path.join(dir, 'wal-out.apkg');

    const pkg = openPackage(input);
    let noteId;
    try {
      pkg.db.exec('PRAGMA journal_mode = WAL');
      assert.equal(pkg.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

      const note = pkg.db.prepare('SELECT id, flds FROM notes LIMIT 1').get();
      noteId = note.id;
      pkg.db.prepare('UPDATE notes SET flds = ? WHERE id = ?').run('written in wal mode', noteId);
      writePackage(pkg, output);
    } finally {
      pkg.close();
    }

    const written = openPackage(output);
    try {
      const note = written.db.prepare('SELECT flds FROM notes WHERE id = ?').get(noteId);
      assert.equal(note.flds, 'written in wal mode');
    } finally {
      written.close();
    }
  });

  it('encodes what Anki would encode', () => {
    const input = path.join(dir, 'golden-out-in.apkg');
    buildPackage(input, { notes: NOTES, media: { 'pic.jpg': 'JPEGDATA' }, format: 'modern' });
    const output = path.join(dir, 'golden-out.apkg');

    const pkg = openPackage(input);
    try {
      writePackage(pkg, output, new Map([[CLIP_NAME, CLIP]]));
    } finally {
      pkg.close();
    }

    const map = zlib.zstdDecompressSync(members(output).get('media').data());
    assert.equal(map.toString('hex'), ANKI_ENCODED);
  });
});
