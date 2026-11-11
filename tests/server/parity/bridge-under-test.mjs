// The bridge client a test talks through: the C core's (server/collection/bridge.c and
// transport.c), driven over the collection-parity protocol (tests/server/parity/protocol.mjs: "probe" and
// "transport", then the same commands, answered by the bridge) by server/build/collection_cli. The
// answers come back in the shapes the tests read, and a failure as a BridgeError with its status, so
// the bridge tests (tests/server/bridge/bridgeLive.test.mjs) check the client against the add-on's real
// server.
export const PROTOCOL_HEADER = 'X-Amgi-Bridge-Protocol';

/** A failure the bridge answered, with its HTTP status (a refused token, a deck not there). */
export class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

import { Impl } from './impl-process.mjs';
import { dec, enc, hex, items, noteTokens, strs, unhex } from './protocol.mjs';

const sessions = new Set();

function errorOf(answer) {
  const [, kind, message] = answer.split('\n')[0].split(' ');
  const k = dec(kind);
  return /^\d+$/.test(k) ? new BridgeError(dec(message), Number(k)) : new Error(dec(message));
}
const ok = (answer) => {
  if (!answer.startsWith('ok')) throw errorOf(answer);
  return answer.split('\n')[0].split(' ').slice(1);
};
const rows = (answer) => answer.split('\n').slice(1);

function statusOf(t) {
  const [profileOpen, profileName, collectionOpen, schema, ankiVersion, qtVersion] = t;
  const status = { profileOpen: profileOpen === '1', profileName: dec(profileName), collectionOpen: collectionOpen === '1' };
  if (schema !== '!') status.schemaVersion = Number(schema);
  return { ...status, ankiVersion: dec(ankiVersion), qtVersion: dec(qtVersion) };
}

/** bridgeClient's ops over a session whose commands go to the bridge. */
function opsOver(impl) {
  const cmd = async (line, more) => impl.cmd(line, more);
  const added = ([noteId, , , warning]) => (warning === '!' ? { noteId: Number(noteId) } : { noteId: Number(noteId), warning: dec(warning) });
  return {
    mode: 'bridge',
    async listDecks() {
      const a = await cmd('listDecks');
      ok(a);
      return rows(a).map((r) => { const [id, name] = r.split(' '); return { id: Number(id), name: dec(name) }; });
    },
    async listNotetypes() {
      const a = await cmd('listNotetypes');
      ok(a);
      return rows(a).map((r) => {
        const [id, name, kind, sortf, fields, templates] = r.split(' ');
        return {
          id: Number(id), name: dec(name), kind: dec(kind), sortFieldIndex: Number(sortf), fieldNames: items(fields).map(dec),
          templates: items(templates).map((t) => {
            const [ord, tn, q, ans] = dec(t).split(' ');
            return { ord: Number(ord), name: dec(tn), questionFormat: dec(q), answerFormat: dec(ans) };
          }),
        };
      });
    },
    async listNotesInDeck(deckId, { offset = 0, limit = 50 } = {}) {
      const a = await cmd(`listNotesInDeck ${deckId} ${offset} ${limit}`);
      const [o, l, , , total] = ok(a);
      const notes = rows(a).map((r) => {
        const [id, mid, fields, tags] = r.split(' ');
        return { id: Number(id), notetypeId: Number(mid), fields: items(fields).map(dec), tags: items(tags).map(dec) };
      });
      return { notes, total: Number(total), offset: Number(o), limit: Number(l) };
    },
    async countNotesInDeck(deckId) { return Number(ok(await cmd(`countNotesInDeck ${deckId}`))[0]); },
    async existingFieldValues(deckId, notetypeId, fieldIndex) {
      return items(ok(await cmd(`existingFieldValues ${deckId} ${notetypeId} ${fieldIndex}`))[0]).map(dec);
    },
    async createDeck(name) {
      const [id, n, created] = ok(await cmd(`createDeck ${enc(name)}`));
      return { deck: { id: Number(id), name: dec(n) }, created: created === '1' };
    },
    async addNote(note) { return added(ok(await cmd(`addNote ${noteTokens(note)}`))); },
    async addNotesBulk(notes) {
      const a = await cmd(`addNotesBulk ${notes.length}`, notes.map(noteTokens));
      ok(a);
      return rows(a).map((r) => {
        const t = r.split(' ');
        return t[0] === 'ok' ? { ok: true, noteId: Number(t[1]), error: '' } : { ok: false, noteId: 0, error: dec(t[1]) };
      });
    },
    async updateNote(noteId, fields, language, learningFieldIndex) {
      const [warning] = ok(await cmd(`updateNote ${noteId} ${strs(fields)} ${enc(language)} ${learningFieldIndex ?? '!'}`));
      return warning === '!' ? { noteId: Number(noteId) } : { noteId: Number(noteId), warning: dec(warning) };
    },
    async hasMedia(filename) { return ok(await cmd(`hasMedia ${enc(filename)}`))[0] === '1'; },
    async renameDeck(deckId, name) {
      const [id, n] = ok(await cmd(`renameDeck ${deckId} ${enc(name)}`));
      return { id: Number(id), name: dec(n) };
    },
    async deckRemovalSummary(deckId) {
      const [id, name, subdecks, cards, notes] = ok(await cmd(`deckRemovalSummary ${deckId}`));
      return { id: Number(id), name: dec(name), subdecks: Number(subdecks), cards: Number(cards), notes: Number(notes) };
    },
    async removeDeck(deckId) {
      const [id, name, decks, cards, notes] = ok(await cmd(`removeDeck ${deckId}`));
      return { id: Number(id), name: dec(name), decks: Number(decks), cards: Number(cards), notes: Number(notes) };
    },
    async removeNote(noteId) {
      const [id, removed] = ok(await cmd(`removeNote ${noteId}`));
      return { noteId: Number(id), cardsRemoved: Number(removed) };
    },
    async readMedia(filename) {
      return unhex(ok(await cmd(`readMedia ${enc(filename)}`))[0]);
    },
    async addMedia(filename, data) { return dec(ok(await cmd(`addMedia ${enc(filename)} ${hex(data)}`))[0]); },
  };
}

/** probeBridge: null, { outdated }, or { ops, status }. */
export async function probeBridgeUnderTest(baseUrl, token) {
  const impl = new Impl();
  sessions.add(impl);
  const t = ok(await impl.cmd(`probe ${enc(baseUrl)} ${enc(token)}`));
  if (t[0] === 'none') return null;
  if (t[0] === 'outdated') return { outdated: new BridgeError(dec(t[1]), 409) };
  return { ops: opsOver(impl), status: statusOf(t.slice(1)) };
}

/** resolveTransport: the mode (and its detail), as transport.js answers. */
export async function resolveTransportUnderTest(settings) {
  const impl = new Impl();
  sessions.add(impl);
  const opt = (v) => (v ? enc(v) : '!');
  const t = ok(await impl.cmd(`transport ${opt(settings.collectionPath)} ${opt(settings.bridge?.baseUrl)} ${opt(settings.bridge?.token)}`));
  const result = { mode: dec(t[0]) };
  if (t[1] !== '!') result.schemaVersion = Number(t[1]);
  if (t.length > 2) result.detail = statusOf(t.slice(2));
  return result;
}

/** Stops every implementation process the tests started. */
export async function closeBridgesUnderTest() {
  for (const impl of sessions) await impl.close();
  sessions.clear();
}
