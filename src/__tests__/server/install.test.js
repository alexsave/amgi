import fs from 'fs';
import os from 'os';
import path from 'path';
import { installAddons, sourceAvailable } from '../../server/anki/install';

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
