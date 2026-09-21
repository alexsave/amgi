import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectionDrift, installAddons, installState, sourceAvailable } from '../../server/anki/install';

// What the website's one-button setup actually puts on disk.
//
// The note type is NOT tested here, on purpose: it is created inside Anki by
// anki/addon/amgi_bridge/notetype.py, against Anki's own API, and is covered
// by test_notetype_collection.py running against a real Collection. What this
// file is responsible for is narrower and entirely checkable from Node - do
// the right folders land in the right place, is anything shipped that should
// not be, and does a machine with no Anki on it get told so rather than
// having a directory invented for it.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

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

  it('finds the add-on sources in this checkout', () => {
    expect(sourceAvailable(REPO_ROOT)).toBe(true);
  });

  it('installs both add-ons into addons21', () => {
    const result = installAddons({ baseDir: base, root: REPO_ROOT });
    expect(result.ok).toBe(true);
    expect(result.installed).toEqual(['amgi_mic', 'amgi_bridge']);
    for (const name of ['amgi_mic', 'amgi_bridge']) {
      expect(fs.existsSync(path.join(base, 'addons21', name, '__init__.py'))).toBe(true);
    }
  });

  it('drops the card type where the add-on looks for it', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const cardType = path.join(base, 'addons21', 'amgi_bridge', 'cardtype');
    for (const name of ['front.html', 'back.html', 'styling.css', '_amgi-loop.js', '_amgi-loop.css']) {
      expect(fs.existsSync(path.join(cardType, name))).toBe(true);
    }
    // The generated loop, not a stale copy of it: the same bytes the repo's
    // own media folder holds.
    expect(fs.readFileSync(path.join(cardType, '_amgi-loop.js'), 'utf8')).toEqual(
      fs.readFileSync(path.join(REPO_ROOT, 'anki', 'media', '_amgi-loop.js'), 'utf8'),
    );
  });

  it('never ships this repo’s test suites or python caches into someone’s Anki', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const bridge = path.join(base, 'addons21', 'amgi_bridge');
    expect(fs.existsSync(path.join(bridge, 'test'))).toBe(false);
    expect(fs.existsSync(path.join(bridge, '__pycache__'))).toBe(false);
  });

  it('is safe to run twice, and clears files a newer version dropped', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    const stale = path.join(base, 'addons21', 'amgi_bridge', 'gone_in_this_version.py');
    fs.writeFileSync(stale, '# left over from an older amgi');

    const again = installAddons({ baseDir: base, root: REPO_ROOT });
    expect(again.ok).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(base, 'addons21', 'amgi_bridge', '__init__.py'))).toBe(true);
  });

  it('never leaves the add-on missing, even when the copy fails partway', () => {
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

    expect(() => installAddons({ baseDir: base, root: REPO_ROOT })).toThrow();

    // The add-on is still there. Under the delete-first version this folder
    // would have been emptied before the failure and left that way.
    expect(fs.existsSync(path.join(bridge, '__init__.py'))).toBe(true);
    expect(fs.existsSync(path.join(bridge, 'bridge_server.py'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'addons21', 'amgi_mic', '__init__.py'))).toBe(true);
  });

  it('leaves the add-on config Anki keeps outside the folder alone', () => {
    installAddons({ baseDir: base, root: REPO_ROOT });
    // Anki stores an add-on's saved config in meta.json beside the folder,
    // not inside it, which is what lets a reinstall keep a bridge token.
    const meta = path.join(base, 'addons21', 'amgi_bridge', '..', 'meta.json');
    fs.writeFileSync(meta, JSON.stringify({ amgi_bridge: { bridgeToken: 'keep-me' } }));
    installAddons({ baseDir: base, root: REPO_ROOT });
    expect(JSON.parse(fs.readFileSync(meta, 'utf8')).amgi_bridge.bridgeToken).toBe('keep-me');
  });

  it('says plainly when there is no Anki on this machine', () => {
    const result = installAddons({ baseDir: path.join(base, 'does-not-exist'), root: REPO_ROOT });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-anki');
    expect(result.message).toMatch(/Install Anki/);
  });

  // Whether a card design change reaches a deck somebody already has comes
  // down to this: the add-on rewrites the note type from its cardtype/
  // folder at every profile open, so the only question the website has to
  // answer is whether the files in that folder are still the ones this build
  // ships. Nothing asked it before, and a machine set up once kept reviewing
  // the old card design with no screen anywhere saying so.
  describe('noticing that what is installed has fallen behind', () => {
    it('reports a fresh install as up to date', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const state = installState({ baseDir: base, root: REPO_ROOT });
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.staleFiles).toEqual([]);
    });

    it('notices an older card template and names it', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const back = path.join(base, 'addons21', 'amgi_bridge', 'cardtype', 'back.html');
      fs.writeFileSync(back, '<div>last year\u2019s card</div>');

      const state = installState({ baseDir: base, root: REPO_ROOT });
      expect(state.upToDate).toBe(false);
      expect(state.staleFiles).toEqual(['amgi_bridge/cardtype/back.html']);
    });

    it('notices an older add-on, not just an older template', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const core = path.join(base, 'addons21', 'amgi_bridge', 'core.py');
      fs.writeFileSync(core, '# an older amgi\n');
      expect(installState({ baseDir: base, root: REPO_ROOT }).upToDate).toBe(false);
    });

    it('counts a file the installed copy has and this build does not', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      fs.writeFileSync(path.join(base, 'addons21', 'amgi_mic', 'removed_since.py'), '# gone in this version');
      expect(installState({ baseDir: base, root: REPO_ROOT }).staleFiles)
        .toEqual(['amgi_mic/removed_since.py']);
    });

    it('ignores the python caches Anki writes into the folder after install', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const cache = path.join(base, 'addons21', 'amgi_bridge', '__pycache__');
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, 'core.cpython-39.pyc'), 'not ours');
      expect(installState({ baseDir: base, root: REPO_ROOT }).upToDate).toBe(true);
    });

    it('running the install again is what makes it current', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      fs.writeFileSync(path.join(base, 'addons21', 'amgi_bridge', 'cardtype', 'styling.css'), '/* old */');
      expect(installState({ baseDir: base, root: REPO_ROOT }).upToDate).toBe(false);

      installAddons({ baseDir: base, root: REPO_ROOT });
      expect(installState({ baseDir: base, root: REPO_ROOT }).upToDate).toBe(true);
    });

    it('says unknown, not up to date, when it has nothing to compare against', () => {
      installAddons({ baseDir: base, root: REPO_ROOT });
      const empty = tempBase();
      try {
        // A packaged build with no add-on sources cannot tell. Claiming
        // "current" there would suppress the only prompt that fixes a stale
        // card design, so the answer has to be null rather than true.
        expect(installState({ baseDir: base, root: empty }).upToDate).toBeNull();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    it('is not up to date when it is not installed at all', () => {
      const state = installState({ baseDir: base, root: REPO_ROOT });
      expect(state.installed).toBe(false);
      expect(state.upToDate).toBeNull();
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

    it('is clean when the collection holds exactly what this build ships', async () => {
      const drift = await collectionDrift({ ops: opsFor(currentNotetype()), root: REPO_ROOT });
      expect(drift).toEqual({ checked: true, stale: [] });
    });

    it('catches a stale FRONT template', async () => {
      const notetype = currentNotetype();
      notetype.templates[0].questionFormat = '<div>last year</div>';
      const drift = await collectionDrift({ ops: opsFor(notetype), root: REPO_ROOT });
      expect(drift.stale).toEqual(['Listening card']);
    });

    it('catches a stale BACK template, which nothing could see before', async () => {
      // listNotetypes never carried answerFormat, so a change that only
      // touched a back template was invisible to every caller.
      const notetype = currentNotetype();
      notetype.templates[1].answerFormat = '<div>last year</div>';
      const drift = await collectionDrift({ ops: opsFor(notetype), root: REPO_ROOT });
      expect(drift.stale).toEqual(['Listening reversed card']);
    });

    it('catches stale media, which is where the review loop actually lives', async () => {
      const ops = opsFor(currentNotetype(), { '_amgi-loop.js': Buffer.from('var old = 1;') });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      expect(drift.stale).toEqual(['_amgi-loop.js']);
    });

    it('catches media the collection does not have at all', async () => {
      const ops = opsFor(currentNotetype(), { '_amgi-loop.css': null });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      expect(drift.stale).toEqual(['_amgi-loop.css']);
    });

    it('says the note type is missing rather than listing every part of it', async () => {
      const ops = opsFor({ id: 2, name: 'Basic', fieldNames: [], templates: [] });
      const drift = await collectionDrift({ ops, root: REPO_ROOT });
      expect(drift.stale).toEqual(['the note type itself']);
    });

    it('reports nothing checked rather than drift when the collection cannot be read', async () => {
      // A locked collection is not an out-of-date card design, and saying so
      // would be a second, wrong explanation on top of the badge that
      // already says what is happening.
      const ops = { listNotetypes: async () => { throw new Error('collection is locked'); }, readMedia: async () => null };
      expect(await collectionDrift({ ops, root: REPO_ROOT })).toEqual({ checked: false, stale: [] });
    });

    it('reports nothing checked when there is no transport at all', async () => {
      expect(await collectionDrift({ ops: null, root: REPO_ROOT })).toEqual({ checked: false, stale: [] });
    });
  });

  it('says plainly when this copy of amgi has no add-ons to install', () => {
    const empty = tempBase();
    try {
      const result = installAddons({ baseDir: base, root: empty });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no-source');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
