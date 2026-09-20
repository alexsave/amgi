import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { defaultBaseDir } from '../../../plusaudio/lib/collection/paths.js';

// Installing amgi into Anki, from the website, with one button.
//
// The owner's objection to the old README was exact and correct: amgi already
// opens collection.anki2 and creates decks, writes notes and adds media
// unattended, and then the setup instructions asked the learner to hand-build
// a six-field note type and paste three files into it. That is strictly
// harder than what the tool already does by itself.
//
// This file does the half of that which is honestly the website's job:
// copying two add-on folders onto disk. It deliberately does NOT try to write
// the note type. A schema-18 collection keeps note types in three tables
// whose config columns are protobuf messages, and hand-encoding those from
// Node would mean guessing field numbers for messages this repo has no
// vendored copy of. Anki's own Python API is correct by construction and is
// already running inside Anki, so the note type is created there instead -
// see anki/addon/amgi_bridge/notetype.py, which this installer feeds by
// dropping the templates into the add-on's own cardtype/ folder.
//
// The division is therefore: the website puts the files where Anki will find
// them, and Anki does the collection surgery the next time it starts. That
// also means this never needs the collection to be closed, and never needs
// to care which transport is live.

// Everything Anki should not see inside an add-on folder: Python's own
// caches, and this repo's test suites, which would otherwise be shipped into
// every user's add-ons directory.
const SKIP_ENTRIES = new Set(['__pycache__', 'test', '.pytest_cache', '.DS_Store']);

const ADDONS = ['amgi_mic', 'amgi_bridge'];

// The card type, copied into amgi_bridge/cardtype/ so the add-on is
// self-contained once installed: it reads these at profile open and needs no
// path back to this checkout to do it.
const CARD_TYPE_FILES = [
  ['anki/notetype/front.html', 'front.html'],
  ['anki/notetype/back.html', 'back.html'],
  ['anki/notetype/front-reverse.html', 'front-reverse.html'],
  ['anki/notetype/back-reverse.html', 'back-reverse.html'],
  ['anki/notetype/styling.css', 'styling.css'],
  ['anki/media/_amgi-loop.js', '_amgi-loop.js'],
  ['anki/media/_amgi-loop.css', '_amgi-loop.css'],
];

export function repoRoot() {
  return process.cwd();
}

/**
 * Is this process running from a checkout that actually has the add-ons in
 * it? A packaged build or a wrong working directory should say so plainly
 * rather than copy an empty folder into someone's Anki.
 */
export function sourceAvailable(root = repoRoot()) {
  return ADDONS.every((name) => fs.existsSync(path.join(root, 'anki', 'addon', name, '__init__.py')));
}

function copyTree(from, to) {
  const written = [];
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      written.push(...copyTree(src, dest));
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
      written.push(dest);
    }
  }
  return written;
}

/**
 * Every file in a tree, as paths relative to it, skipping the same entries
 * the copy skips. A `__pycache__` Anki wrote after the install is not part
 * of what amgi put there, and counting it would make a current install look
 * stale forever.
 */
function fileList(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...fileList(path.join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * What THIS build of amgi would put in the add-ons folder: a map from the
 * path it installs to, to the hash of the bytes it would write.
 *
 * Content hashes rather than a version number anyone has to remember to
 * bump. A version constant is a promise to update a second thing every time
 * you change a template, and the failure mode when someone forgets is
 * silent - the learner keeps reviewing on the old card design and nothing
 * anywhere says so.
 */
export function shippedManifest(root = repoRoot()) {
  const manifest = {};
  for (const name of ADDONS) {
    const dir = path.join(root, 'anki', 'addon', name);
    for (const rel of fileList(dir)) manifest[`${name}/${rel}`] = digest(path.join(dir, rel));
  }
  for (const [from, to] of CARD_TYPE_FILES) {
    manifest[`amgi_bridge/cardtype/${to}`] = digest(path.join(root, from));
  }
  return manifest;
}

/** The same map, read back off whatever is installed in `addonsDir`. */
export function installedManifest(addonsDir) {
  const manifest = {};
  for (const name of ADDONS) {
    const dir = path.join(addonsDir, name);
    for (const rel of fileList(dir)) manifest[`${name}/${rel}`] = digest(path.join(dir, rel));
  }
  return manifest;
}

/**
 * Is amgi already installed in this Anki, and is what is installed current?
 *
 * "Installed" is the question the setup screen keys off, and it is NOT "has
 * a profile been picked". A machine with Anki on it resolves a default
 * profile whether or not amgi has ever run, so keying setup off the profile
 * meant the setup screen could never appear for the people who need it. What
 * distinguishes a fresh machine is that amgi's own add-ons are not in the
 * add-ons folder yet.
 *
 * "Current" is the second question, and it is the one that makes a card
 * design change actually reach a deck somebody already has. The chain is:
 * the website copies the templates into the add-on's cardtype/ folder, and
 * the add-on compares them against the collection at profile open and
 * rewrites the note type in place where they differ (see
 * anki/addon/amgi_bridge/notetype.py). That second half has always worked.
 * The first half was the gap - nothing ever re-copied, so someone who
 * installed once kept reviewing last year's card forever and no screen
 * anywhere said so. Hashing what is on disk against what this build ships
 * closes it.
 *
 * `staleFiles` names what differs rather than just counting, because the
 * answer is worth seeing when this goes wrong: a template that keeps coming
 * back stale after a refresh means the copy is failing, not that an update
 * is pending.
 *
 * Note that the note type itself is still never inspected here. It is
 * created and refreshed by the add-on on the next profile open, so
 * "the files on disk are current" is the thing this side can both check and
 * act on, and the note type follows from it.
 */
export function installState({ baseDir, root = repoRoot() } = {}) {
  const base = baseDir || defaultBaseDir();
  const addonsDir = path.join(base, 'addons21');
  const installed = ADDONS.every((name) => fs.existsSync(path.join(addonsDir, name, '__init__.py')));

  let staleFiles = [];
  let comparable = false;
  if (installed && sourceAvailable(root)) {
    comparable = true;
    const want = shippedManifest(root);
    const have = installedManifest(addonsDir);
    const paths = new Set([...Object.keys(want), ...Object.keys(have)]);
    staleFiles = [...paths].filter((rel) => want[rel] !== have[rel]).sort();
  }

  return {
    installed,
    // Unknown is not the same as current. A build with no add-on sources in
    // it cannot tell, and must not claim the install is up to date - saying
    // so would suppress the one prompt that fixes a stale card design.
    upToDate: comparable ? staleFiles.length === 0 : null,
    staleFiles,
    baseDir: base,
    baseDirExists: fs.existsSync(base),
    addonsDir,
  };
}

/**
 * Copy both add-ons, and the card type they install, into an Anki base
 * directory.
 *
 * Overwrites whatever is there: this is how an amgi update reaches an
 * existing install, and the add-on folders are ours, not the learner's, so
 * there is nothing of theirs to preserve inside them. Their own config.json,
 * which Anki keeps in a separate meta.json alongside the folder rather than
 * inside it, is untouched - which is what keeps a bridge token and port
 * surviving a reinstall.
 */
export function installAddons({ baseDir, root = repoRoot() } = {}) {
  const base = baseDir || defaultBaseDir();

  if (!sourceAvailable(root)) {
    return {
      ok: false,
      reason: 'no-source',
      message: 'This copy of amgi has no add-on sources in it, so there is nothing to install from.',
      baseDir: base,
    };
  }
  if (!fs.existsSync(base)) {
    return {
      ok: false,
      reason: 'no-anki',
      message: `No Anki data folder at ${base}. Install Anki and open it once, then try again.`,
      baseDir: base,
    };
  }

  const addonsDir = path.join(base, 'addons21');
  fs.mkdirSync(addonsDir, { recursive: true });

  const installed = [];
  for (const name of ADDONS) {
    const target = path.join(addonsDir, name);
    // Remove first rather than copying over the top: a file this version no
    // longer ships would otherwise linger and keep being imported.
    fs.rmSync(target, { recursive: true, force: true });
    copyTree(path.join(root, 'anki', 'addon', name), target);
    installed.push(name);
  }

  const cardTypeDir = path.join(addonsDir, 'amgi_bridge', 'cardtype');
  fs.mkdirSync(cardTypeDir, { recursive: true });
  const cardType = [];
  for (const [from, to] of CARD_TYPE_FILES) {
    fs.copyFileSync(path.join(root, from), path.join(cardTypeDir, to));
    cardType.push(to);
  }

  return {
    ok: true,
    baseDir: base,
    addonsDir,
    installed,
    cardType,
    message:
      'Installed. Restart Anki - it will add the "amgi Listening" note type and its files to your collection on the way up.',
  };
}
