// Installs amgi into a fixture folder the way the Install into Anki button does (add-ons into
// <dir>/addons21, the "amgi Listening" note type into <dir>/collection.anki2), by calling the
// server's own install code: no server needed. Run with the server's module hooks:
//   node --import ./ui/server/hooks.mjs ui/tools/fixture-install.mjs <dir>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(process.argv[2]);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const install = await import(pathToFileURL(path.join(root, 'src/server/anki/install.js')).href);
const { resolveTransport } = await import(pathToFileURL(path.join(root, 'src/server/anki/transport.js')).href);
const result = install.installAddons({ baseDir: dir });
if (!result.ok) throw new Error(`install failed: ${result.message}`);
const transport = await resolveTransport({ baseDirOverride: dir, collectionPath: path.join(dir, 'collection.anki2'), profileName: '', bridge: { baseUrl: '', token: '' } });
const notetype = await install.installNotetypeDirect({ ops: transport.ops });
if (!notetype.created && notetype.existed !== true) throw new Error('the note type was not made');
console.log(`installed into ${dir} (mode ${transport.mode})`);
