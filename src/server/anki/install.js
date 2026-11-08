import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { defaultBaseDir } from '../../../plusaudio/lib/collection/paths.js';
import { AMGI_NOTETYPE_NAME } from '../../utils/amgiNotetype';

// Installing amgi into Anki, from the website, with one button.
//
// The owner's objection to the old README was exact and correct: amgi already
// opens collection.anki2 and creates decks, writes notes and adds media
// unattended, and then the setup instructions asked the learner to hand-build
// a six-field note type and paste three files into it. That is strictly
// harder than what the tool already does by itself.
//
// Two writers make the note type, and which one runs depends on whether Anki
// is open, so what each covers is written down here:
//
//   - Anki CLOSED (the direct transport): installNotetypeDirect() below writes
//     the note type and its two media files itself, through
//     plusaudio/lib/collection/notetype-write.js. The add-card form works the
//     moment the install finishes. That module's header has the story of why
//     this used to be refused (hand-encoded protobuf nobody could validate)
//     and what validates it now.
//   - Anki OPEN, or any collection amgi cannot write: this installer only
//     copies the add-on folders onto disk, and the add-on creates the note
//     type through Anki's own Python API at the next profile open
//     (anki/addon/amgi_bridge/notetype.py, fed by the cardtype/ folder
//     copied below). It is also the only thing that REFRESHES an existing
//     note type whose templates or css have drifted.
//
// They are deliberately not merged: the add-on is correct by construction
// across Anki versions and is the path for everything that already exists,
// while the Node writer exists only so a first install into a closed
// collection needs no restart. The add-on treats a note type the Node writer
// made as current (an equivalence test enforces that it changes nothing).
// Either way the files go to disk first, so a later Anki start has everything.

// Everything Anki should not see inside an add-on folder: Python's own
// caches, and this repo's test suites, which would otherwise be shipped into
// every user's add-ons directory.
const SKIP_ENTRIES = new Set(['__pycache__', 'test', '.pytest_cache', '.DS_Store']);

const ADDONS = ['amgi_mic', 'amgi_bridge'];

// What installAddons says on its own: it only copies files, so the note type
// still has to be made by the add-on when Anki next starts. The route replaces
// this once installNotetypeDirect has made it itself.
export const RESTART_MESSAGE =
  'Installed. Restart Anki - it will add the "amgi Listening" note type and its files to your collection on the way up.';
export const INSTALLED_MESSAGE =
  'Installed. The "amgi Listening" card type is already in your collection, so you can add cards now. Anki picks the add-ons up the next time it starts.';

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

// What the add-on puts INSIDE the collection, as opposed to what this
// installer puts on disk next to it. Named separately because they are
// checked separately: the two halves fail independently, and for a while
// only the first half was ever checked (see collectionDrift).
const COLLECTION_MEDIA = ['_amgi-loop.js', '_amgi-loop.css'];
const COLLECTION_TEMPLATES = [
  { name: 'Listening', front: 'anki/notetype/front.html', back: 'anki/notetype/back.html' },
  { name: 'Listening reversed', front: 'anki/notetype/front-reverse.html', back: 'anki/notetype/back-reverse.html' },
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
 * Has the collection itself actually picked up what is on disk?
 *
 * This is the half that was missing, and its absence is exactly the shape of
 * bug it was supposed to prevent. The website copies files into the add-on
 * folder and then reported success; the add-on, which is the only thing that
 * can write a note type, does its half at the NEXT profile open. Anybody who
 * restarted Anki before the copy landed - or simply had not restarted since -
 * was left reviewing the old card while every screen said the install was
 * current. Checking files on disk answers "did we do our part", which is not
 * the question anyone is asking.
 *
 * Reads only. Nothing here writes to the collection. Drift in an EXISTING
 * note type is fixed by the add-on at the next Anki start, not by the Node
 * writer, which only ever creates a missing note type (see this file's
 * header for the split).
 *
 * The stylesheet is not checked: listNotetypes does not carry a note type's
 * css, so there is no honest way to compare it from here. Templates and media
 * are, and media is the half that actually broke - it is written last and is
 * where the whole review loop lives.
 */
export async function collectionDrift({ ops, root = repoRoot() }) {
  if (!ops || !sourceAvailable(root)) return { checked: false, stale: [] };

  const stale = [];
  try {
    const notetypes = await ops.listNotetypes();
    const notetype = notetypes.find((nt) => nt.name === AMGI_NOTETYPE_NAME);
    if (!notetype) return { checked: true, stale: ['the note type itself'], installed: false };

    const byName = new Map((notetype.templates || []).map((t) => [t.name, t]));
    for (const spec of COLLECTION_TEMPLATES) {
      const template = byName.get(spec.name);
      if (!template) {
        stale.push(`${spec.name} card`);
        continue;
      }
      const front = fs.readFileSync(path.join(root, spec.front), 'utf8');
      const back = fs.readFileSync(path.join(root, spec.back), 'utf8');
      if (template.questionFormat !== front || template.answerFormat !== back) stale.push(`${spec.name} card`);
    }

    for (const name of COLLECTION_MEDIA) {
      const shipped = fs.readFileSync(path.join(root, 'anki', 'media', name));
      const inCollection = await ops.readMedia(name);
      if (!inCollection || Buffer.compare(Buffer.from(inCollection), shipped) !== 0) stale.push(name);
    }
  } catch (error) {
    // An unreadable collection is not drift, it is a collection that cannot
    // be read - the badge already says so, and claiming the card design is
    // out of date on top of that would be a second, wrong explanation.
    return { checked: false, stale: [] };
  }

  return { checked: true, stale };
}

// The note type, as the Node writer needs it. Field and template order, the
// names and the legacy requirement list must equal what notetype.py builds;
// notetype-write.test.js compares the two decoded, so editing one side only
// fails a test instead of shipping two different note types.
const NOTETYPE_FIELDS = ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'];
// Legacy "which fields must be non-empty for this card to exist": the forward
// card needs CueAudio (ord 1), the reverse card TargetAudio (ord 3).
const NOTETYPE_REQUIREMENTS = [
  { ord: 0, kind: 'any', fields: [1] },
  { ord: 1, kind: 'any', fields: [3] },
];

/** The amgi note type as plusaudio's createNotetype takes it, read from the shipped card files. */
export function amgiNotetypeSpec(root = repoRoot()) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  return {
    name: AMGI_NOTETYPE_NAME,
    fields: NOTETYPE_FIELDS,
    templates: COLLECTION_TEMPLATES.map((t) => ({ name: t.name, front: read(t.front), back: read(t.back) })),
    css: read('anki/notetype/styling.css'),
    requirements: NOTETYPE_REQUIREMENTS,
  };
}

/**
 * Create the note type now, if the collection can be written from here.
 *
 * Only a transport that offers createNotetype can (the direct one, Anki
 * closed); the bridge cannot, because with Anki open the add-on does it.
 * Never throws: whatever goes wrong here, the add-on path is still there and
 * the install itself has already succeeded, so a failure is reported and the
 * caller falls back to "restart Anki".
 *
 * @returns {Promise<{created: boolean, existed?: boolean, reason?: string}>}
 */
export async function installNotetypeDirect({ ops, root = repoRoot() }) {
  if (!ops || typeof ops.createNotetype !== 'function') return { created: false, reason: 'transport' };
  try {
    const media = {};
    for (const name of COLLECTION_MEDIA) media[name] = fs.readFileSync(path.join(root, 'anki', 'media', name));
    const result = await ops.createNotetype(amgiNotetypeSpec(root), media);
    if (result.created) return { created: true };
    return { created: false, existed: result.reason === 'exists', reason: result.reason };
  } catch (error) {
    return { created: false, reason: error.kind || 'error' };
  }
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
    const source = path.join(root, 'anki', 'addon', name);

    // Written over the top, then anything this version no longer ships is
    // removed afterwards - NOT deleted first and recopied.
    //
    // The delete-first version had a window, however short, in which the
    // add-on folder did not exist. Anki may well be running while this
    // happens: it imports these modules at startup and keeps the bridge
    // server going out of them, so a module resolved lazily during that
    // window fails, in the middle of somebody's review, for reasons nothing
    // on screen explains. Overlaying leaves every path that existed before
    // this call still existing throughout it, including when the copy itself
    // fails partway. The prune afterwards keeps the property the delete was
    // there for: a file this version dropped does not linger and get
    // imported.
    copyTree(source, target);
    const shipped = new Set(fileList(source));
    for (const rel of fileList(target)) {
      if (shipped.has(rel)) continue;
      try {
        fs.rmSync(path.join(target, rel));
      } catch {
        // Left for next time. A stale file is a smaller problem than a
        // half-installed add-on, and everything that matters is written.
      }
    }
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
    message: RESTART_MESSAGE,
  };
}
