// The install and starter sequence over HTTP, as the page drives it, written as lines a golden file
// can hold: what golden_install_starter.test.mjs replays against the C server and what
// make-golden-install-starter.mjs (scaffolding) recorded once from the Node server.
//
// On a fresh Anki folder with one profile and Anki closed: the install's state, the install, the
// state after it, the note types (the amgi note type the direct install writes), the starter's
// offer, the starter deck in en->ko, the same again (every phrase already there), a second pair
// (ko->ja), the decks with their counts, the starter deck's notes, and the media folder's files
// with their sizes and SHA-1s (the clips and the template's files copied in).
//
// Ids, paths and times are normalised: an id becomes <kind#n> by first appearance, the Anki folder
// <base>, so the same sequence gives the same lines on any run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KINDS = {
  'GET /install': 'install_state', 'POST /install': 'installed', 'GET /notetypes': 'notetypes',
  'GET /starter': 'starter_state', 'POST /starter': 'starter_built', 'GET /decks': 'decks', 'GET /notes': 'notes',
};

/** Lines for a decoded answer object: one per leaf, keys in the object's order, nested by path. */
function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    out.push(`${prefix}=[${value.length}]`);
    value.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
  } else if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push(`${prefix}=${String(value)}`);
  }
}

export async function runSteps({ url, ankiDir, repo, decode, WIRE_MIME, encode }) {
  const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
  const headers = {
    'X-Amgi-Base-Dir': encodeURIComponent(ankiDir), 'X-Amgi-Collection': encodeURIComponent(collection),
    'X-Amgi-Profile': encodeURIComponent('User 1'),
  };
  const ids = new Map();
  const counters = {};
  const norm = (text) => text.split(ankiDir).join('<base>').replace(/\b1[67]\d{11}\b/g, (id) => {
    if (!ids.has(id)) {
      const kind = 'id';
      counters[kind] = (counters[kind] || 0) + 1;
      ids.set(id, `<id#${counters[kind]}>`);
    }
    return ids.get(id);
  });
  const lines = [];
  async function call(method, route, kind, body, sendKind) {
    const init = { method, headers: { ...headers } };
    if (body) {
      init.headers['Content-Type'] = WIRE_MIME;
      init.body = encode(sendKind, body);
    }
    const response = await fetch(`${url}/api/anki${route}`, init);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const object = decode(response.status < 400 ? kind : 'error', bytes);
    lines.push(`== ${method} ${route.replace(/\/decks\/\d+/, '/decks/<deck>')} ${response.status}`);
    const out = [];
    flatten(object, '', out);
    for (const l of out) lines.push(norm(l));
    return object;
  }
  await call('GET', '/install', KINDS['GET /install']);
  await call('POST', '/install', KINDS['POST /install'], { baseDirOverride: ankiDir }, 'q_install');
  await call('GET', '/install', KINDS['GET /install']);
  await call('GET', '/notetypes', KINDS['GET /notetypes']);
  await call('GET', '/starter', KINDS['GET /starter']);
  const built = await call('POST', '/starter', KINDS['POST /starter'], { known: 'en', learning: 'ko', name: 'amgi starter' }, 'q_starter');
  await call('POST', '/starter', KINDS['POST /starter'], { known: 'en', learning: 'ko', name: 'amgi starter' }, 'q_starter');
  await call('POST', '/starter', KINDS['POST /starter'], { known: 'ko', learning: 'ja', name: 'amgi starter ja' }, 'q_starter');
  await call('GET', '/decks', KINDS['GET /decks']);
  await call('GET', `/decks/${built.deckId}/notes?offset=0&limit=50`, KINDS['GET /notes']);
  const media = path.join(ankiDir, 'User 1', 'collection.media');
  lines.push('== media');
  // A file copied from the repository is named by where it came from, byte for byte; anything else
  // by its size and SHA-1.
  const sources = ['anki/media', 'anki/starter/media'];
  for (const name of fs.readdirSync(media).sort()) {
    const data = fs.readFileSync(path.join(media, name));
    const from = sources.find((dir) => {
      const file = path.join(repo, dir, name);
      return fs.existsSync(file) && fs.readFileSync(file).equals(data);
    });
    lines.push(from ? `${name} = ${from}` : `${name} ${data.length} ${crypto.createHash('sha1').update(data).digest('hex')}`);
  }
  return lines;
}
