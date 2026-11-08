'use strict';

// createNotetype, proven against the real Anki library, not against our own
// reader: the Node-written note type is opened by Anki itself, used to add a
// note, checked for the cards it generates, and put through Check Database.
// The matching test that the SHIPPED amgi note type is equivalent to the
// add-on's is src/__tests__/server/installNotetype.test.js, which has the
// card files; this one uses a small spec so it can cover the writer's own
// rules (idempotence, names, ids, rollback, media) without them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');
const { createNotetype } = require('../../lib/collection/notetype-write');

const skip = !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)';

const SPEC = {
  name: 'Writer Test',
  fields: ['Front', 'FrontAudio', 'Back'],
  templates: [
    { name: 'Forward', front: '{{FrontAudio}}', back: '{{FrontSide}}<hr id=answer>{{Back}}' },
    { name: 'Backward', front: '{{Back}}', back: '{{FrontSide}}<hr id=answer>{{Front}}' },
  ],
  css: '.card { color: red; }\n',
  requirements: [
    { ord: 0, kind: 'any', fields: [1] },
    { ord: 1, kind: 'any', fields: [2] },
  ],
};

function fresh({ schema = 18 } = {}) {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  buildFixtureCollection(collectionPath, { downgradeToSchema11: schema === 11 });
  return { dir, collectionPath, col: new Collection(collectionPath) };
}

test('createNotetype: Anki opens it, adds a note with it, makes both cards, and Check Database is clean', { skip }, () => {
  const { dir, collectionPath, col } = fresh();
  const outcome = col.createNotetype(SPEC, { '_writer-test.js': Buffer.from('// js\n') });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.result.created, true);

  const report = withAnkiLibrary(
    collectionPath,
    `
nt = col.models.by_name(${JSON.stringify(SPEC.name)})
assert nt is not None, "Anki cannot find the note type"
assert nt["id"] == ${outcome.result.notetypeId}, "id differs"
assert [f["name"] for f in nt["flds"]] == ["Front", "FrontAudio", "Back"], nt["flds"]
assert [f["ord"] for f in nt["flds"]] == [0, 1, 2]
assert [t["name"] for t in nt["tmpls"]] == ["Forward", "Backward"]
assert nt["tmpls"][0]["qfmt"] == "{{FrontAudio}}" and nt["tmpls"][1]["afmt"].endswith("{{Front}}")
assert nt["css"] == ".card { color: red; }\\n", repr(nt["css"])
assert nt["type"] == 0 and nt["sortf"] == 0
did = col.decks.id("Default")
note = col.new_note(nt)
note["Front"] = "f"; note["FrontAudio"] = "[sound:a.mp3]"; note["Back"] = "b"
col.add_note(note, did)
assert len(col.get_note(note.id).cards()) == 2, "expected both cards generated"
# A note with no FrontAudio only has the backward card (cardgen reads the
# templates themselves, not the requirement list).
other = col.new_note(nt); other["Front"] = "x"; other["Back"] = "y"
col.add_note(other, did)
assert len(col.get_note(other.id).cards()) == 1
problems = col.fix_integrity()
msg = problems.problems if hasattr(problems, "problems") else problems
print("INTEGRITY:", msg)
print("PRAGMA:", col.db.scalar("pragma integrity_check"))
print("DECKS:", [d.name for d in col.decks.all_names_and_ids()])
# The legacy requirement list is written as given, and Anki decodes it as such.
import sqlite3
from anki import notetypes_pb2 as pb
c = sqlite3.connect(col.path); c.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
cfg = pb.Notetype.Config.FromString(c.execute("select config from notetypes where id = ?", (nt["id"],)).fetchone()[0])
print("REQS:", [(r.card_ord, r.kind, list(r.field_ords)) for r in cfg.reqs])
`,
  );
  assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);
  assert.match(report, /PRAGMA: ok/);
  assert.match(report, /REQS: \[\(0, 1, \[1\]\), \(1, 1, \[2\]\)\]/);
  assert.equal(fs.readFileSync(path.join(dir, 'collection.media', '_writer-test.js'), 'utf8'), '// js\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createNotetype: an existing name (any case) is left alone, and its media is not touched', { skip }, () => {
  const { dir, col } = fresh();
  const first = col.createNotetype(SPEC, { '_w.js': Buffer.from('one') });
  assert.equal(first.result.created, true);
  const second = col.createNotetype({ ...SPEC, name: 'writer TEST', css: 'x' }, { '_w.js': Buffer.from('two') });
  assert.equal(second.result.created, false);
  assert.equal(second.result.reason, 'exists');
  assert.equal(second.result.notetypeId, first.result.notetypeId);
  assert.equal(fs.readFileSync(path.join(dir, 'collection.media', '_w.js'), 'utf8'), 'one');
  assert.equal(col.listNotetypes().result.filter((nt) => nt.name.toLowerCase() === 'writer test').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createNotetype: ids come from the injected source and are unique per field and template', { skip }, () => {
  const { dir, collectionPath } = fresh();
  let counter = 0;
  const randomBytes = (n) => {
    counter += 1;
    return Buffer.alloc(n, 0).fill(counter, n - 1);
  };
  const outcome = createNotetype(collectionPath, SPEC, { now: () => 1700000000123, randomBytes });
  assert.equal(outcome.result.notetypeId, 1700000000123);
  const ids = withAnkiLibrary(
    collectionPath,
    `
import sqlite3
from anki import notetypes_pb2 as pb
c = sqlite3.connect(col.path); c.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
out = [pb.Notetype.Field.Config.FromString(r[0]).id for r in c.execute("select config from fields where ntid = 1700000000123 order by ord")]
out += [pb.Notetype.Template.Config.FromString(r[0]).id for r in c.execute("select config from templates where ntid = 1700000000123 order by ord")]
print("IDS:", out)
`,
  );
  assert.match(ids, /IDS: \[1, 2, 3, 4, 5\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createNotetype: a schema 11 collection is reported, not written', { skip }, () => {
  const { dir, col } = fresh({ schema: 11 });
  const outcome = col.createNotetype(SPEC, { '_w.js': Buffer.from('x') });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.result, { created: false, reason: 'legacy-schema' });
  assert.equal(fs.existsSync(path.join(dir, 'collection.media', '_w.js')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createNotetype: a failure part way leaves no note type behind and no media written', { skip }, () => {
  const { dir, collectionPath, col } = fresh();
  // A template name that collides with another one trips the (ntid, name)
  // unique index on the third insert, after the notetype row and fields exist.
  const broken = { ...SPEC, templates: [SPEC.templates[0], { ...SPEC.templates[1], name: 'forward' }] };
  assert.throws(() => col.createNotetype(broken, { '_w.js': Buffer.from('x') }), /UNIQUE|constraint/i);
  assert.equal(col.listNotetypes().result.some((nt) => nt.name === SPEC.name), false);
  assert.equal(fs.existsSync(path.join(dir, 'collection.media', '_w.js')), false);
  // The relaxed collations were restored on the way out: the schema text on
  // disk still says unicase (a rollback that took the restore with it would
  // leave NOCASE there for good), and Anki still opens the file.
  const db = new DatabaseSync(collectionPath);
  try {
    for (const table of ['notetypes', 'fields', 'templates']) {
      const { sql } = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table);
      assert.match(sql, /COLLATE unicase/, `${table} schema lost its unicase collation`);
    }
  } finally {
    db.close();
  }
  withAnkiLibrary(collectionPath, 'assert col.models.by_name("Basic") is not None');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createNotetype: a bad spec is refused before the collection is opened', () => {
  assert.throws(() => createNotetype('/nonexistent.anki2', { ...SPEC, fields: [] }), /fields/);
  assert.throws(() => createNotetype('/nonexistent.anki2', { ...SPEC, fields: ['A', 'a'] }), /unique/);
  assert.throws(() => createNotetype('/nonexistent.anki2', { ...SPEC, name: '' }), /name/);
});

test('createNotetype: a collection Anki has open is reported as locked and nothing is written', { skip }, async () => {
  const { dir, col, collectionPath } = fresh();
  const { holdCollectionOpen } = require('./helpers/anki-python');
  const holder = holdCollectionOpen(collectionPath);
  await holder.held;
  try {
    const outcome = col.createNotetype(SPEC, { '_w.js': Buffer.from('x') });
    assert.equal(outcome.status, 'locked');
    assert.equal(fs.existsSync(path.join(dir, 'collection.media', '_w.js')), false);
  } finally {
    await holder.release();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
