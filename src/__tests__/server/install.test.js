import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectionDrift, installAddons, installState, sourceAvailable } from '../../server/anki/install';

// What the website's one-button setup actually puts on disk.
//
// The note type is NOT tested here, on purpose: with Anki open it is created
// inside Anki by anki/addon/amgi_bridge/notetype.py (covered by
// test_notetype_collection.py against a real Collection), and with Anki closed
// by the Node writer (covered against the real library, and against the
// add-on's output, in installNotetype.test.js). What this
// file is responsible for is narrower and entirely checkable from Node - do
// the right folders land in the right place, is anything shipped that should
// not be, and does a machine with no Anki on it get told so rather than
// having a directory invented for it.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-install-'));
}

describe('installing amgi into an Anki data folder', () => {
  let base;

  beforeEach(() => {
    base = tempBase();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('finds the add-on sources in this checkout', () => {
    assert.equal(sourceAvailable(REPO_ROOT), true);
  });

  test('installs both add-ons into addons21', () => {
    const result = installAddons({ baseDir: base, root: REPO_ROOT });
    assert.equal(result.ok, true);
    assert.deepEqual(result.installed, ['amgi_mic', 'amgi_bridge']);
    for (const name of ['amgi_mic', 'amgi_bridge']) {
      assert.equal(fs.existsSync(path.join(base, 'addons21', name, '__init__.py')), true);
    }
  });

  test('drops the card type where the add-on looks for it', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const cardType = path.join(base, 'addons21', 'amgi_bridge', 'cardtype');
    for (const name of ['front.html', 'back.html', 'styling.css', '_amgi-loop.js', '_amgi-loop.css']) {
      assert.equal(fs.existsSync(path.join(cardType, name)), true);
    }
    // The generated loop, not a stale copy of it: the same bytes the repo's
    // own media folder holds.
    assert.deepEqual(fs.readFileSync(path.join(cardType, '_amgi-loop.js'), 'utf8'), 
      fs.readFileSync(path.join(REPO_ROOT, 'anki', 'media', '_amgi-loop.js'), 'utf8'),
    );
  });

  test('never ships this repo’s test suites or python caches into someone’s Anki', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const bridge = path.join(base, 'addons21', 'amgi_bridge');
    assert.equal(fs.existsSync(path.join(bridge, 'test')), false);
    assert.equal(fs.existsSync(path.join(bridge, '__pycache__')), false);
  });

  test('is safe to run twice, and clears files a newer version dropped', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const stale = path.join(base, 'addons21', 'amgi_bridge', 'gone_in_this_version.py');
    fs.writeFileSync(stale, '# left over from an older amgi');

    const again = installAddons({ baseDir: base, root: REPO_ROOT });
    assert.equal(again.ok, true);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(path.join(base, 'addons21', 'amgi_bridge', '__init__.py')), true);
  });

  test('never leaves the add-on missing, even when the copy fails partway', () => {
    // Anki may well be running while this happens - it imported these modules
    // at startup and keeps the bridge server going out of them - so an
    // install that deletes the folder first has a window where a lazily
    // resolved import fails, in the middle of somebody's review, for reasons
    // nothing on screen explains. Writing over the top has no such window.
    // Proven by making the copy fail: a directory where a file has to go
    // makes copyFileSync throw EISDIR partway through.
    installAddons({ baseDir: base, root: REPO_ROOT });
    const bridge = path.join(base, 'addons21', 'amgi_bridge');
    const blocker = path.join(bridge, 'core.py');
    fs.rmSync(blocker);
    fs.mkdirSync(blocker);

    assert.throws(() => installAddons({ baseDir: base, root: REPO_ROOT }));

    // The add-on is still there. Under the delete-first version this folder
    // would have been emptied before the failure and left that way.
    assert.equal(fs.existsSync(path.join(bridge, '__init__.py')), true);
    assert.equal(fs.existsSync(path.join(bridge, 'bridge_server.py')), true);
    assert.equal(fs.existsSync(path.join(base, 'addons21', 'amgi_mic', '__init__.py')), true);
  });

  test('leaves the add-on config Anki keeps outside the folder alone', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    // Anki stores an add-on's saved config in meta.json beside the folder,
    // not inside it, which is what lets a reinstall keep a bridge token.
    const meta = path.join(base, 'addons21', 'amgi_bridge', '..', 'meta.json');
    fs.writeFileSync(meta, JSON.stringify({ amgi_bridge: { bridgeToken: 'keep-me' } }));
    installAddons({ baseDir: base, root: REPO_ROOT });
    assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).amgi_bridge.bridgeToken, 'keep-me');
  });

  test('says plainly when there is no Anki on this machine', () => {
    const result = installAddons({ baseDir: path.join(base, 'does-not-exist'), root: REPO_ROOT });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-anki');
    assert.match(result.message, /Install Anki/);
  });

  // Whether a card design change reaches a deck somebody already has comes
  // down to this: the add-on rewrites the note type from its cardtype/
  // folder at every profile open, so the only question the website has to
  // answer is whether the files in that folder are still the ones this build
  // ships. Nothing asked it before, and a machine set up once kept reviewing
  // the old card design with no screen anywhere saying so.
  describe('noticing that what is installed has fallen behind', () => {
    test('reports a fresh install as up to date', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const state = installState({ baseDir: base, root: REPO_ROOT });
      assert.equal(state.installed, true);
      assert.equal(state.upToDate, true);
      assert.deepEqual(state.staleFiles, []);
    });

    test('notices an older card template and names it', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const back = path.join(base, 'addons21', 'amgi_bridge', 'cardtype', 'back.html');
      fs.writeFileSync(back, '<div>last year\u2019s card</div>');

      const state = installState({ baseDir: base, root: REPO_ROOT });
      assert.equal(state.upToDate, false);
      assert.deepEqual(state.staleFiles, ['amgi_bridge/cardtype/back.html']);
    });

    test('notices an older add-on, not just an older template', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const core = path.join(base, 'addons21', 'amgi_bridge', 'core.py');
      fs.writeFileSync(core, '# an older amgi\n');
      assert.equal(installState({ baseDir: base, root: REPO_ROOT }).upToDate, false);
    });

    test('counts a file the installed copy has and this build does not', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      fs.writeFileSync(path.join(base, 'addons21', 'amgi_mic', 'removed_since.py'), '# gone in this version');
      assert.deepEqual(installState({ baseDir: base, root: REPO_ROOT }).staleFiles, ['amgi_mic/removed_since.py']);
    });

    test('ignores the python caches Anki writes into the folder after install', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const cache = path.join(base, 'addons21', 'amgi_bridge', '__pycache__');
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, 'core.cpython-39.pyc'), 'not ours');
      assert.equal(installState({ baseDir: base, root: REPO_ROOT }).upToDate, true);
    });

    test('running the install again is what makes it current', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      fs.writeFileSync(path.join(base, 'addons21', 'amgi_bridge', 'cardtype', 'styling.css'), '/* old */');
      assert.equal(installState({ baseDir: base, root: REPO_ROOT }).upToDate, false);

      installAddons({ baseDir: base, root: REPO_ROOT });
      assert.equal(installState({ baseDir: base, root: REPO_ROOT }).upToDate, true);
    });

    test('says unknown, not up to date, when it has nothing to compare against', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const empty = tempBase();
      try {
        // A packaged build with no add-on sources cannot tell. Claiming
        // "current" there would suppress the only prompt that fixes a stale
        // card design, so the answer has to be null rather than true.
        assert.equal(installState({ baseDir: base, root: empty }).upToDate, null);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    test('is not up to date when it is not installed at all', () => {
      const state = installState({ baseDir: base, root: REPO_ROOT });
      assert.equal(state.installed, false);
      assert.equal(state.upToDate, null);
    });
  });

  // The half that matters most, because its absence looked exactly like
  // success: files perfectly current on disk while the collection still held
  // the old card, and every screen saying the install was done.
  describe('noticing that ANKI has not caught up with what is on disk', () => {
    const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const currentNotetype = () => ({
      id: 1,
      name: 'amgi Listening',
      fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'],
      templates: [
        { ord: 0, name: 'Listening', questionFormat: read('anki/notetype/front.html'), answerFormat: read('anki/notetype/back.html') },
        { ord: 1, name: 'Listening reversed', questionFormat: read('anki/notetype/front-reverse.html'), answerFormat: read('anki/notetype/back-reverse.html') },
      ],
    });
    const opsFor = (notetype, media = {}) => ({
      listNotetypes: async () => [notetype],
      readMedia: async (name) => (name in media
        ? media[name]
        : fs.readFileSync(path.join(REPO_ROOT, 'anki', 'media', name))),
    });

    test('is clean when the collection holds exactly what this build ships', async () => {
      const drift = await collectionDrift({ ops: opsFor(currentNotetype()), root: REPO_ROOT });
      assert.deepEqual(drift, { checked: true, stale: [] });
    });

    test('catches a stale FRONT template', async () => {
      const notetype = currentNotetype();
      notetype.templates[0].questionFormat = '<div>last year</div>';
      const drift = await collectionDrift({ ops: opsFor(notetype), root: REPO_ROOT });
      assert.deepEqual(drift.stale, ['Listening card']);
    });

    test('catches a stale BACK template, which nothing could see before', async () => {
      // listNotetypes never carried answerFormat, so a change that only
      // touched a back template was invisible to every caller.
      const notetype = currentNotetype();
      notetype.templates[1].answerFormat = '<div>last year</div>';
      const drift = await collectionDrift({ ops: opsFor(notetype), root: REPO_ROOT });
      assert.deepEqual(drift.stale, ['Listening reversed card']);
    });

    test('catches stale media, which is where the review loop actually lives', async () => {
      const ops = opsFor(currentNotetype(), { '_amgi-loop.js': Buffer.from('var old = 1;') });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      assert.deepEqual(drift.stale, ['_amgi-loop.js']);
    });

    test('catches media the collection does not have at all', async () => {
      const ops = opsFor(currentNotetype(), { '_amgi-loop.css': null });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      assert.deepEqual(drift.stale, ['_amgi-loop.css']);
    });

    test('says the note type is missing rather than listing every part of it', async () => {
      const ops = opsFor({ id: 2, name: 'Basic', fieldNames: [], templates: [] });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      assert.deepEqual(drift.stale, ['the note type itself']);
    });

    test('reports nothing checked rather than drift when the collection cannot be read', async () => {
      // A locked collection is not an out-of-date card design, and saying so
      // would be a second, wrong explanation on top of the badge that
      // already says what is happening.
      const ops = { listNotetypes: async () => { throw new Error('collection is locked'); }, readMedia: async () => null };
      assert.deepEqual(await collectionDrift({ ops, root: REPO_ROOT }), { checked: false, stale: [] });
    });

    test('reports nothing checked when there is no transport at all', async () => {
      assert.deepEqual(await collectionDrift({ ops: null, root: REPO_ROOT }), { checked: false, stale: [] });
    });
  });

  test('says plainly when this copy of amgi has no add-ons to install', () => {
    const empty = tempBase();
    try {
      const result = installAddons({ baseDir: base, root: empty });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'no-source');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
