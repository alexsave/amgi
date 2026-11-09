'use strict';

// The collection core a test writes through, behind one small async face: the C core's
// server/build/collection_cli (make -C server), or the program AMGI_COLLECTION_IMPL names, over the
// collection-parity protocol (test/parity/protocol.mjs). A test that checks what the core writes
// against real Anki reads it through this.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { sandboxEnv } = require(path.join(ROOT, 'test', 'sandbox-home.cjs'));
const IMPL = process.env.AMGI_COLLECTION_IMPL || path.join(ROOT, 'server', 'build', 'collection_cli');

/** The C core, over the protocol. */
async function overProtocol(collectionPath) {
  const { dec, enc, items, noteTokens, strs } = await import(path.join(ROOT, 'test', 'parity', 'protocol.mjs'));
  const child = spawn(IMPL, [], { env: sandboxEnv(), stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const waiting = [];
  const drain = () => {
    for (let nl; waiting.length && (nl = buffer.indexOf('\n')) >= 0;) {
      const text = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      waiting.shift()(text);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    drain();
  });
  const line = () => new Promise((resolve) => {
    waiting.push(resolve);
    drain();
  });
  const cmd = async (text, following = () => 0) => {
    child.stdin.write(`${text}\n`);
    const first = await line();
    if (!first.startsWith('ok')) throw new Error(dec(first.split(' ')[2] ?? '~'));
    const rest = [];
    for (let i = following(first); i > 0; i -= 1) rest.push(await line());
    return [first.split(' ').slice(1), rest];
  };
  await cmd(`open ${enc(collectionPath)}`);
  return {
    name: path.basename(IMPL),
    async listNotetypes() {
      const [, rows] = await cmd('listNotetypes', (first) => Number(first.split(' ')[1]));
      return rows.map((row) => {
        const [id, name, , sortf, fields] = row.split(' ');
        return { id: Number(id), name: dec(name), sortFieldIndex: Number(sortf), fieldNames: items(fields).map(dec) };
      });
    },
    async createDeck(name) {
      const [[id, n]] = await cmd(`createDeck ${enc(name)}`);
      return { id: Number(id), name: dec(n) };
    },
    async addNote(note) {
      const [[noteId]] = await cmd(`addNote ${noteTokens(note)}`);
      return { noteId: Number(noteId) };
    },
    async updateNote(id, fields) {
      await cmd(`updateNote ${id} ${strs(fields)} ! !`);
      return undefined;
    },
    async close() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end('quit\n');
      await exited;
    },
  };
}

/** The collection core under test, opened on `collectionPath`. */
function openCollectionUnderTest(collectionPath) {
  return overProtocol(collectionPath);
}

module.exports = { openCollectionUnderTest };
