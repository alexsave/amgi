'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { augmentPackage } = require('../lib/augment');
const { UnsupportedPackageError } = require('../lib/package');
const { readZip, writeZip } = require('../lib/zip');
const { buildPackage } = require('./helpers/build-package');
const { inspectPackage } = require('./helpers/inspect');

const NOW_RUN_1 = 1_760_000_000;
const NOW_RUN_2 = 1_770_000_000;

// Deterministic stand-in for the TTS call: no key, no network, and identical
// text always yields identical bytes, which is what makes "did anything
// change?" answerable by comparing packages.
function stubGenerator(calls) {
  return async ({ text }) => {
    calls.push(text);
    return Buffer.from(`clip:${crypto.createHash('sha1').update(text).digest('hex')}`);
  };
}

const SOURCE_NOTES = [
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
    // An author recording and an image already in the audio field: neither is
    // ours, so both have to survive.
    fields: ['질문 <b>있습니까</b>?&nbsp;', '[sound:1-1-13-2.mp3]<img src="pic.jpg">', '1-1-13-2'],
  },
  {
    id: 1547294520938,
    guid: 'rb|-&h]@hB',
    mod: 1596473886,
    fields: ['가: 이것을 어떻게?', '<img src="pic.jpg">', '1-1-13-3'],
  },
  {
    id: 1547294664607,
    guid: 'LVD:T2EKo`',
    mod: 1597946187,
    fields: ['', '', '1-2-15-1'],
  },
];

const SOURCE_REVLOG = [
  { id: 1500000000000, cid: 1547294175189 },
  { id: 1500000600000, cid: 1547294381724 },
  { id: 1500001200000, cid: 1547294520939 },
];

let dir;

function makeSource(name, overrides = {}) {
  const target = path.join(dir, name);
  buildPackage(target, {
    notes: SOURCE_NOTES,
    revlog: SOURCE_REVLOG,
    media: { 'pic.jpg': 'JPEGDATA', '1-1-13-2.mp3': 'MP3DATA' },
    ...overrides,
  });
  return target;
}

async function run(inputPath, outputPath, options = {}) {
  const calls = [];
  const summary = await augmentPackage({
    inputPath,
    outputPath,
    generate: stubGenerator(calls),
    now: NOW_RUN_1,
    ...options,
  });
  return { summary, calls };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plusaudio-test-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('augmentPackage', () => {
  it('adds audio without changing the identity of anything', async () => {
    const input = makeSource('identity.apkg');
    const output = path.join(dir, 'identity-out.apkg');
    const { summary, calls } = await run(input, output);

    assert.equal(summary.notesTotal, 4);
    assert.equal(summary.notesChanged, 3);
    assert.equal(summary.audioGenerated, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      summary.skipped.map((s) => s.reason),
      ['empty-text'],
    );

    const before = inspectPackage(input);
    const after_ = inspectPackage(output);

    assert.deepEqual(after_.guids, before.guids, 'note guids must be preserved');
    assert.deepEqual(
      after_.notes.map((n) => n.id),
      before.notes.map((n) => n.id),
      'note ids must be preserved',
    );
    assert.deepEqual(
      after_.notes.map((n) => n.mid),
      before.notes.map((n) => n.mid),
      'note type ids must be preserved',
    );
    assert.equal(after_.revlogDigest, before.revlogDigest, 'revlog must be byte-identical');
    assert.equal(after_.revlog.length, 3);
    assert.equal(after_.cardsDigest, before.cardsDigest, 'cards and their scheduling must be untouched');
    assert.equal(after_.col.decks, before.col.decks, 'deck names and ids must be untouched');
    assert.equal(after_.col.models, before.col.models, 'note types must be untouched');
    assert.equal(after_.col.crt, before.col.crt);
  });

  it('bumps mod only on the notes whose content it changed', async () => {
    const input = makeSource('mod.apkg');
    const output = path.join(dir, 'mod-out.apkg');
    await run(input, output);

    const before = new Map(inspectPackage(input).notes.map((n) => [n.id, n]));
    for (const note of inspectPackage(output).notes) {
      const original = before.get(note.id);
      if (note.flds === original.flds) {
        assert.equal(note.mod, original.mod, `note ${note.id} was not changed but its mod moved`);
      } else {
        assert.equal(note.mod, NOW_RUN_1, `note ${note.id} changed but was not stamped`);
      }
    }
  });

  it('keeps audio and images it did not generate, and points at real media', async () => {
    const input = makeSource('fields.apkg');
    const output = path.join(dir, 'fields-out.apkg');
    await run(input, output);

    const result = inspectPackage(output);
    const byId = new Map(result.notes.map((n) => [n.id, n.flds.split('\x1f')]));

    const authorRecording = byId.get(1547294381723)[1];
    assert.match(authorRecording, /\[sound:1-1-13-2\.mp3\]/, 'the author recording must survive');
    assert.match(authorRecording, /<img src="pic\.jpg">/, 'the image must survive');
    assert.match(authorRecording, /\[sound:plusaudio-[0-9a-f]{20}\.mp3\]/);

    assert.match(byId.get(1547294520938)[1], /<img src="pic\.jpg">\[sound:plusaudio-/);
    assert.equal(byId.get(1547294664607)[1], '', 'a note with no text must be left alone');

    for (const note of result.notes) {
      for (const [, name] of note.flds.matchAll(/\[sound:([^\]]+)\]/g)) {
        assert.ok(result.mediaNames.has(name), `${name} is referenced but not in the package`);
      }
    }
    assert.equal(result.mediaNames.size, 5, '2 original media files plus 3 generated clips');
  });

  it('is a no-op when re-run on its own output', async () => {
    const input = makeSource('idempotent.apkg');
    const first = path.join(dir, 'idempotent-1.apkg');
    const second = path.join(dir, 'idempotent-2.apkg');

    await run(input, first);
    const { summary, calls } = await run(first, second, { now: NOW_RUN_2 });

    assert.equal(summary.notesChanged, 0);
    assert.equal(summary.audioGenerated, 0);
    assert.equal(calls.length, 0, 'unchanged text must cost nothing');
    assert.equal(summary.audioUpToDate, 3);
    assert.deepEqual(
      fs.readFileSync(second),
      fs.readFileSync(first),
      're-running on the output must reproduce it byte for byte',
    );
  });

  it('regenerates only the note whose text changed', async () => {
    const input = makeSource('edit.apkg');
    const first = path.join(dir, 'edit-1.apkg');
    await run(input, first);

    // The user edits one note's text in Anki and re-exports.
    const edited = makeSource('edit-input-2.apkg', {
      notes: SOURCE_NOTES.map((note, i) =>
        i === 0 ? { ...note, fields: ['<div>안녕히 가세요</div>', '', '1-1-13-1'] } : note,
      ),
    });
    const cacheDir = path.join(dir, 'cache');

    // Prime the cache the way run 1 would have.
    await run(input, path.join(dir, 'edit-prime.apkg'), { cacheDir });
    const { summary, calls } = await run(edited, path.join(dir, 'edit-2.apkg'), {
      cacheDir,
      now: NOW_RUN_2,
    });

    assert.deepEqual(calls, ['안녕히 가세요'], 'only the edited note is generated');
    assert.equal(summary.audioFromCache, 2, 'the untouched notes come from the cache');
    assert.equal(summary.audioGenerated, 1);
  });

  it('serves a second run from the on-disk cache without calling the generator', async () => {
    const input = makeSource('cache.apkg');
    const cacheDir = path.join(dir, 'cache-2');
    await run(input, path.join(dir, 'cache-1.apkg'), { cacheDir });
    const { summary, calls } = await run(input, path.join(dir, 'cache-2.apkg'), { cacheDir });

    assert.equal(calls.length, 0);
    assert.equal(summary.audioFromCache, 3);
  });

  it('handles the legacy2 layout and leaves the compatibility stub alone', async () => {
    const input = makeSource('legacy2.apkg', { format: 'legacy2' });
    const output = path.join(dir, 'legacy2-out.apkg');
    const { summary } = await run(input, output);

    assert.equal(summary.format, 'legacy2');
    assert.equal(summary.notesChanged, 3);

    const members = new Map(readZip(output).map((e) => [e.name, e.data()]));
    assert.deepEqual(members.get('meta'), Buffer.from([0x08, 0x02]), 'meta must be carried through');
    assert.equal(members.get('collection.anki2').toString(), 'legacy stub, not a database');
  });

  it('edits the database that meta points at, not whichever one is present', async () => {
    // A version 1 package carrying a stray collection.anki21: Anki reads
    // collection.anki2, so editing the other one would be a silent no-op.
    const source = makeSource('meta-source.apkg');
    const input = path.join(dir, 'meta.apkg');
    const members = readZip(source).map((e) => ({ name: e.name, data: e.data() }));
    const collection = members.find((m) => m.name === 'collection.anki2').data;
    writeZip(input, [...members, { name: 'collection.anki21', data: collection }]);

    const output = path.join(dir, 'meta-out.apkg');
    const { summary } = await run(input, output);
    assert.equal(summary.format, 'legacy1');

    const edited = new Map(readZip(output).map((e) => [e.name, e.data()]));
    assert.ok(!edited.get('collection.anki2').equals(collection), 'collection.anki2 must be the one edited');
    assert.deepEqual(edited.get('collection.anki21'), collection, 'the stray database must be left alone');
  });

  it('regenerates a clip whose media file has gone missing from the package', async () => {
    const input = makeSource('dangling.apkg');
    const first = path.join(dir, 'dangling-1.apkg');
    await run(input, first);

    // Drop one generated clip's member but leave its media map entry.
    const members = readZip(first).map((e) => ({ name: e.name, data: e.data() }));
    const mediaMap = JSON.parse(members.find((m) => m.name === 'media').data.toString());
    const lostId = Object.keys(mediaMap).find((id) => mediaMap[id].startsWith('plusaudio-'));
    const broken = path.join(dir, 'dangling-broken.apkg');
    writeZip(broken, members.filter((m) => m.name !== lostId));

    const repaired = path.join(dir, 'dangling-2.apkg');
    const { summary, calls } = await run(broken, repaired, { now: NOW_RUN_2 });
    assert.equal(calls.length, 1, 'only the missing clip is regenerated');
    assert.equal(summary.audioGenerated, 1);
    // The note already said the right thing, so replacing the file is enough;
    // there is no reason to stamp it as modified.
    assert.equal(summary.notesChanged, 0);

    const fixed = new Map(readZip(repaired).map((e) => [e.name, e.data()]));
    const fixedMap = JSON.parse(fixed.get('media').toString());
    const restoredId = Object.keys(fixedMap).find((id) => fixedMap[id] === mediaMap[lostId]);
    assert.ok(fixed.has(restoredId), 'the missing clip must be back in the package');
  });

  it('refuses a modern package rather than silently passing it through', async () => {
    const input = path.join(dir, 'modern.apkg');
    writeZip(input, [
      { name: 'meta', data: Buffer.from([0x08, 0x03]) },
      { name: 'collection.anki21b', data: Buffer.from('zstd') },
      { name: 'media', data: Buffer.from(' binary') },
    ]);

    await assert.rejects(
      () => run(input, path.join(dir, 'modern-out.apkg')),
      (error) =>
        error instanceof UnsupportedPackageError && /Support older Anki versions/.test(error.message),
    );
  });

  it('stops at --limit without leaving a dangling sound reference', async () => {
    const input = makeSource('limit.apkg');
    const output = path.join(dir, 'limit-out.apkg');
    const { summary } = await run(input, output, { limit: 1 });

    assert.equal(summary.audioGenerated, 1);
    assert.equal(summary.notesChanged, 1);

    const result = inspectPackage(output);
    for (const note of result.notes) {
      for (const [, name] of note.flds.matchAll(/\[sound:([^\]]+)\]/g)) {
        assert.ok(result.mediaNames.has(name), `${name} is referenced but not in the package`);
      }
    }
  });

  it('leaves a note alone when its generation fails', async () => {
    const input = makeSource('failure.apkg');
    const output = path.join(dir, 'failure-out.apkg');
    const summary = await augmentPackage({
      inputPath: input,
      outputPath: output,
      now: NOW_RUN_1,
      generate: async ({ text }) => {
        if (text.startsWith('질문')) throw new Error('no voice worked');
        return Buffer.from(`clip:${text}`);
      },
    });

    assert.equal(summary.notesChanged, 2);
    assert.equal(summary.skipped.length, 2);

    const before = new Map(inspectPackage(input).notes.map((n) => [n.id, n]));
    const failed = inspectPackage(output).notes.find((n) => n.id === 1547294381723);
    assert.equal(failed.flds, before.get(1547294381723).flds);
    assert.equal(failed.mod, before.get(1547294381723).mod);
  });
});
