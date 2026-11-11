// Installs amgi into a fixture folder the way the Install into Anki button does (add-ons into
// <dir>/addons21, the "amgi Listening" note type into <dir>/collection.anki2, or <dir>/User 1's): it
// starts the C server on a free port and sends it the button's own request.
//   node ui/tools/fixture-install.mjs <dir> [--addons-only]
// --addons-only installs the add-ons and leaves the note type out (a collection Anki has not caught up
// with): the request names no collection, so only the file half runs.
import fs from 'node:fs';
import path from 'node:path';
import { WIRE_MIME, decode, encode } from '../wire/wire.mjs';
import { startServer } from '../../tests/server/parity/servers.mjs';

const dir = path.resolve(process.argv[2]);
const addonsOnly = process.argv[3] === '--addons-only';
// the fixture's own collection, or its one profile's (ui/tools/flows.sh makes "User 1")
const direct = path.join(dir, 'collection.anki2');
const collectionPath = fs.existsSync(direct) ? direct : path.join(dir, 'User 1', 'collection.anki2');

const server = await startServer({ key: '', base: null });
try {
  const headers = { 'content-type': WIRE_MIME, 'x-amgi-base-dir': encodeURIComponent(dir) };
  if (!addonsOnly) headers['x-amgi-collection'] = encodeURIComponent(collectionPath);
  const response = await fetch(new URL('/api/anki/install', server.url), {
    method: 'POST', headers, body: encode('q_install', { baseDirOverride: dir }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) throw new Error(`install failed: ${decode('error', bytes)?.error ?? response.status}`);
  const answer = decode('installed', bytes);
  if (!addonsOnly && answer.needsRestart) throw new Error('the note type was not made');
  console.log(addonsOnly ? `add-ons installed into ${dir}` : `installed into ${dir}`);
} finally {
  await server.stop();
}
