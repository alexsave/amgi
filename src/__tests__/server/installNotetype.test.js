/**
 * @jest-environment node
 */

// The note type amgi's installer creates itself when Anki is closed, checked
// against the REAL Anki library and against the add-on's own writer.
//
// Two writers make this note type (see install.js's header for the split), so
// the thing worth proving is that they cannot drift apart: the note type the
// Node side writes must decode, row for row, to what anki/addon/amgi_bridge/
// notetype.py writes, and running the add-on over the Node-made one must change
// nothing. Both halves are tested here with the real shipped card files.
//
// Skipped, like the plusaudio suites, when there is no python with the anki
// library (ANKI_PYTHON_BIN).

import fs from 'node:fs';
import path from 'node:path';

import { amgiNotetypeSpec, installNotetypeDirect } from '../../server/anki/install';
import { createDirectOps } from '../../server/anki/directClient';

const helpers = require('../../../plusaudio/test/collection/helpers/anki-python');

const { anki, buildFixtureCollection, holdCollectionOpen, runPython, tempDir } = helpers;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const maybe = anki ? it : it.skip;

function freshCollection() {
  const dir = tempDir('amgi-notetype-');
  const collectionPath = path.join(dir, 'collection.anki2');
  buildFixtureCollection(collectionPath);
  return { dir, collectionPath };
}

// The card files exactly as the installer copies them into the add-on's own
// cardtype/ folder, which is what ensure_notetype reads.
function assetsDir() {
  const dir = tempDir('amgi-assets-');
  for (const f of ['front.html', 'back.html', 'front-reverse.html', 'back-reverse.html', 'styling.css']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'anki', 'notetype', f), path.join(dir, f));
  }
  for (const f of ['_amgi-loop.js', '_amgi-loop.css']) fs.copyFileSync(path.join(REPO_ROOT, 'anki', 'media', f), path.join(dir, f));
  return dir;
}

describe('amgiNotetypeSpec', () => {
  it('is read from the shipped card files, in the add-on’s field and template order', () => {
    const spec = amgiNotetypeSpec(REPO_ROOT);
    expect(spec.name).toBe('amgi Listening');
    expect(spec.fields).toEqual(['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes']);
    expect(spec.templates.map((t) => t.name)).toEqual(['Listening', 'Listening reversed']);
    expect(spec.templates[0].front).toBe(fs.readFileSync(path.join(REPO_ROOT, 'anki/notetype/front.html'), 'utf8'));
    expect(spec.css).toBe(fs.readFileSync(path.join(REPO_ROOT, 'anki/notetype/styling.css'), 'utf8'));
  });
});

describe('installNotetypeDirect', () => {
  it('does nothing on a transport that cannot write (the bridge: the add-on does it there)', async () => {
    expect(await installNotetypeDirect({ ops: { listNotetypes: async () => [] }, root: REPO_ROOT })).toEqual({
      created: false,
      reason: 'transport',
    });
    expect(await installNotetypeDirect({ ops: undefined, root: REPO_ROOT })).toEqual({ created: false, reason: 'transport' });
  });

  maybe('creates the note type and its media in a closed collection, once', async () => {
    const { dir, collectionPath } = freshCollection();
    const ops = createDirectOps(collectionPath);
    expect(await installNotetypeDirect({ ops, root: REPO_ROOT })).toEqual({ created: true });

    const made = (await ops.listNotetypes()).find((nt) => nt.name === 'amgi Listening');
    expect(made.fieldNames).toEqual(['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes']);
    for (const name of ['_amgi-loop.js', '_amgi-loop.css']) {
      expect(Buffer.compare(await ops.readMedia(name), fs.readFileSync(path.join(REPO_ROOT, 'anki', 'media', name)))).toBe(0);
    }

    const again = await installNotetypeDirect({ ops, root: REPO_ROOT });
    expect(again).toMatchObject({ created: false, existed: true });
    expect((await ops.listNotetypes()).filter((nt) => nt.name === 'amgi Listening')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  maybe('reports a locked collection instead of throwing, so the install can fall back to the add-on', async () => {
    const { dir, collectionPath } = freshCollection();
    const holder = holdCollectionOpen(collectionPath);
    await holder.held;
    try {
      const result = await installNotetypeDirect({ ops: createDirectOps(collectionPath), root: REPO_ROOT });
      expect(result).toEqual({ created: false, reason: 'locked' });
    } finally {
      await holder.release();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The whole point of having two writers be safe: Anki's own code, run over
  // the Node-made note type, finds nothing to do, and the two note types
  // decode identically apart from the random ids Anki assigns.
  maybe('makes the same note type as the add-on, and the add-on then leaves it untouched', async () => {
    const node = freshCollection();
    const addon = freshCollection();
    const assets = assetsDir();
    expect(await installNotetypeDirect({ ops: createDirectOps(node.collectionPath), root: REPO_ROOT })).toEqual({ created: true });

    const script = `
import importlib.util, sqlite3, sys
from anki.collection import Collection
from anki import notetypes_pb2 as pb

node_path, addon_path, assets, notetype_py = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("amgi_notetype", notetype_py)
nt = importlib.util.module_from_spec(spec); spec.loader.exec_module(nt)

# The add-on's own writer, into a second fresh collection: the reference.
col = Collection(addon_path); made = nt.ensure_notetype(col, assets); col.close()
assert made.created, made

# And over the Node-made one: it must find nothing to do.
col = Collection(node_path)
before = col.db.scalar("select mod from col")
r = nt.ensure_notetype(col, assets)
after = col.db.scalar("select mod from col")
print("CHANGED:", r.changed, "|", r.summary())
print("MOD UNTOUCHED:", before == after)
model = col.models.by_name("amgi Listening")
did = col.decks.id("Default")
note = col.new_note(model)
note["Cue"] = "where is the station"; note["CueAudio"] = "[sound:a.mp3]"
note["Target"] = "eki"; note["TargetAudio"] = "[sound:b.mp3]"; note["Language"] = "ja"
col.add_note(note, did)
print("CARDS:", len(col.get_note(note.id).cards()))
problems = col.fix_integrity()
print("INTEGRITY:", problems.problems if hasattr(problems, "problems") else problems)
col.close()

def conn(p):
    c = sqlite3.connect(p)
    c.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    return c

def dump(p):
    c = conn(p)
    nid, nname, usn, cfg = c.execute("select id, name, usn, config from notetypes where name = 'amgi Listening'").fetchone()
    fields = []
    for name, cf in c.execute("select name, config from fields where ntid = ? order by ord", (nid,)):
        m = pb.Notetype.Field.Config.FromString(cf); assert m.HasField("id"); m.ClearField("id")
        fields.append((name, m.SerializeToString()))
    tmpls = []
    for name, mt, u, cf in c.execute("select name, mtime_secs, usn, config from templates where ntid = ? order by ord", (nid,)):
        m = pb.Notetype.Template.Config.FromString(cf); assert m.HasField("id"); m.ClearField("id")
        tmpls.append((name, mt, u, m.SerializeToString()))
    return {"name": nname, "usn": usn, "config": cfg, "fields": fields, "templates": tmpls}

a, b = dump(node_path), dump(addon_path)
for key in a:
    print("SAME", key, a[key] == b[key])
`;
    const report = runPython(script, [
      node.collectionPath,
      addon.collectionPath,
      assets,
      path.join(REPO_ROOT, 'anki', 'addon', 'amgi_bridge', 'notetype.py'),
    ]);
    expect(report).toMatch(/CHANGED: False \| amgi Listening is already up to date/);
    expect(report).toMatch(/MOD UNTOUCHED: True/);
    expect(report).toMatch(/CARDS: 2/);
    expect(report).toMatch(/INTEGRITY:.*rebuilt and optimized/i);
    for (const key of ['name', 'usn', 'config', 'fields', 'templates']) expect(report).toContain(`SAME ${key} True`);

    for (const d of [node.dir, addon.dir, assets]) fs.rmSync(d, { recursive: true, force: true });
  });
});
