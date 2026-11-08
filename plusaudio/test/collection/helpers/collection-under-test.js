'use strict';

// The collection core a test writes through, behind one small async face: plusaudio/lib/collection
// in this process, or, with AMGI_COLLECTION_IMPL=<executable> (the C core's server/build/collection_cli),
// that program over the collection-parity protocol (test/parity/protocol.mjs). A test that checks
// what the core writes against real Anki then checks either implementation unchanged.

const { spawn } = require('node:child_process');
const path = require('node:path');

const { Collection } = require('../../../lib/collection');

const IMPL = process.env.AMGI_COLLECTION_IMPL;
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function unwrap(outcome) {
  if (outcome.status !== 'ok') throw new Error(`collection is ${outcome.status}`);
  return outcome.result;
}

/** plusaudio/lib/collection, in this process. */
function inProcess(collectionPath) {
  const col = new Collection(collectionPath);
  return {
    name: 'node',
    async listNotetypes() { return unwrap(col.listNotetypes()); },
    async createDeck(name) { return unwrap(col.createDeck(name)).deck; },
    async addNote(note) { return unwrap(col.addNote(note)); },
    async updateNote(id, fields) { return unwrap(col.updateNote(id, fields)); },
    async close() {},
  };
}

/** The implementation at AMGI_COLLECTION_IMPL, over the protocol. */
async function overProtocol(collectionPath) {
  const { dec, enc, items, noteTokens, strs } = await import(path.join(ROOT, 'test', 'parity', 'protocol.mjs'));
  const child = spawn(IMPL, [], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  return IMPL ? overProtocol(collectionPath) : Promise.resolve(inProcess(collectionPath));
}

module.exports = { openCollectionUnderTest };
