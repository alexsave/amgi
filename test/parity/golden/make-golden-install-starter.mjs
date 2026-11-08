// SCAFFOLDING, removed at L4: records the install and starter sequence (install-starter-steps.mjs)
// once from the Node server of an amgi checkout that still has one (amgi main before L4), into
// install-starter-expected.txt.
//
//   ANKI_PYTHON_BIN=... node test/parity/golden/make-golden-install-starter.mjs <node checkout>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSteps } from './install-starter-steps.mjs';
import { freshAnki } from './fresh-anki.mjs';

const checkout = path.resolve(process.argv[2]);
const { WIRE_MIME, decode, encode } = await import(path.join(checkout, 'ui', 'server', 'wire.mjs'));
const ankiDir = freshAnki(process.env.ANKI_PYTHON_BIN);
const server = spawn(process.execPath, ['ui/server/serve.mjs'], {
  cwd: checkout, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', GEMINI_API_KEY: '' },
});
const url = await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    const m = /amgi on (http:\/\/\S+)/.exec(chunk.toString());
    if (m) resolve(m[1]);
  });
  server.once('exit', (code) => reject(new Error(`the Node server exited ${code}`)));
});
try {
  const lines = await runSteps({ url, ankiDir, repo: checkout, decode, WIRE_MIME, encode });
  fs.writeFileSync(path.join(import.meta.dirname, 'install-starter-expected.txt'), `${lines.join('\n')}\n`);
  console.log(`${lines.length} lines recorded from ${url}`);
} finally {
  server.kill();
  fs.rmSync(ankiDir, { recursive: true, force: true });
}
