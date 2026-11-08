// Installs amgi into a fixture folder the way the Install into Anki button does (add-ons into
// <dir>/addons21, the "amgi Listening" note type into <dir>/collection.anki2, or <dir>/User 1's), by calling the
// server's own install code: no server needed. Run with the server's module hooks:
//   node --import ./ui/server/hooks.mjs ui/tools/fixture-install.mjs <dir> [--addons-only]
// --addons-only installs the add-ons and leaves the note type out (a collection Anki has not caught up with).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(process.argv[2]);
const addonsOnly = process.argv[3] === '--addons-only';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const install = await import(pathToFileURL(path.join(root, 'src/server/anki/install.js')).href);
const { resolveTransport } = await import(pathToFileURL(path.join(root, 'src/server/anki/transport.js')).href);
const result = install.installAddons({ baseDir: dir });
if (!result.ok) throw new Error(`install failed: ${result.message}`);
if (addonsOnly) {
  console.log(`add-ons installed into ${dir}`);
  process.exit(0);
}
// the fixture's own collection, or its one profile's (ui/tools/flows.sh makes "User 1")
const direct = path.join(dir, 'collection.anki2');
const collectionPath = fs.existsSync(direct) ? direct : path.join(dir, 'User 1', 'collection.anki2');
const transport = await resolveTransport({ baseDirOverride: dir, collectionPath, profileName: '', bridge: { baseUrl: '', token: '' } });
const notetype = await install.installNotetypeDirect({ ops: transport.ops });
if (!notetype.created && notetype.existed !== true) throw new Error('the note type was not made');
console.log(`installed into ${dir} (mode ${transport.mode})`);
