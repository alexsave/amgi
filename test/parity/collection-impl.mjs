// The Node implementation of the collection-parity protocol (test/parity/protocol.mjs): today's
// collection code, reached exactly as the server reaches it, through the direct transport's ops
// (src/server/anki/directClient.js: the per-path lock chain, then plusaudio/lib/collection with
// its backup ledger). One process is one server session: the ledger and the chains live as long
// as it does.
//
//   node --import ./ui/server/hooks.mjs test/parity/collection-impl.mjs
import readline from 'node:readline';
import { createDirectOps } from '../../src/server/anki/directClient.js';
import { dec, enc, hex, items, list, nums, strs, noteOf, unhex } from './protocol.mjs';

let ops = null;

function failure(error) {
  const kind = error?.kind || (error?.status ? String(error.status) : 'error');
  return `err ${enc(kind)} ${enc(error?.message ?? String(error))}`;
}

const added = (r) => `${r.noteId} ${enc(r.guid)} ${nums(r.cardIds)} ${enc(r.warning)}`;

const COMMANDS = {
  async open([path]) {
    ops = createDirectOps(dec(path));
    return 'ok';
  },
  async status() {
    const s = await ops.status();
    return `ok ${enc(s.status)} ${s.schemaVersion ?? '!'}`;
  },
  async listDecks() {
    const decks = await ops.listDecks();
    return [`ok ${decks.length}`, ...decks.map((d) => `${d.id} ${enc(d.name)}`)].join('\n');
  },
  async countNotesInDeck([deck]) {
    return `ok ${await ops.countNotesInDeck(Number(deck))}`;
  },
  async listNotetypes() {
    const nts = await ops.listNotetypes();
    return [`ok ${nts.length}`, ...nts.map((n) => [
      n.id, enc(n.name), enc(n.kind), n.sortFieldIndex, strs(n.fieldNames),
      list(n.templates.map((t) => enc([t.ord, enc(t.name), enc(t.questionFormat), enc(t.answerFormat)].join(' ')))),
    ].join(' '))].join('\n');
  },
  async listNotesInDeck([deck, offset, limit]) {
    const page = await ops.listNotesInDeck(Number(deck), { offset: Number(offset), limit: Number(limit) });
    return [`ok ${page.offset} ${page.limit} ${page.hasMore ? 1 : 0} ${page.notes.length}`,
      ...page.notes.map((n) => `${n.id} ${n.notetypeId} ${strs(n.fields)} ${strs(n.tags)}`)].join('\n');
  },
  async existingFieldValues([deck, notetype, field]) {
    return `ok ${strs(await ops.existingFieldValues(Number(deck), Number(notetype), Number(field)))}`;
  },
  async createDeck([name]) {
    const r = await ops.createDeck(dec(name));
    return `ok ${r.deck.id} ${enc(r.deck.name)} ${r.created ? 1 : 0}`;
  },
  async renameDeck([deck, name]) {
    const r = await ops.renameDeck(Number(deck), dec(name));
    return `ok ${r.id} ${enc(r.name)} ${r.childrenRenamed}`;
  },
  async deckRemovalSummary([deck]) {
    const r = await ops.deckRemovalSummary(Number(deck));
    return `ok ${r.id} ${enc(r.name)} ${r.subdecks} ${r.cards} ${r.notes}`;
  },
  async removeDeck([deck]) {
    const r = await ops.removeDeck(Number(deck));
    return `ok ${r.id} ${enc(r.name)} ${r.decks} ${r.cards} ${r.notes}`;
  },
  async addNote(tokens) {
    return `ok ${added(await ops.addNote(noteOf(tokens)))}`;
  },
  async addNotesBulk(_tokens, lines) {
    const results = await ops.addNotesBulk(lines.map((line) => noteOf(line.split(' '))));
    return [`ok ${results.length}`, ...results.map((r) => (r.ok ? `ok ${added(r)}` : `err ${enc(r.error)}`))].join('\n');
  },
  async updateNote([note, fields, language, lfi]) {
    const r = await ops.updateNote(Number(note), items(fields).map(dec), dec(language), lfi === '!' ? undefined : Number(lfi));
    return `ok ${enc(r?.warning)}`;
  },
  async removeNote([note]) {
    const r = await ops.removeNote(Number(note));
    return `ok ${r.noteId} ${r.cardsRemoved}`;
  },
  async hasMedia([name]) {
    return `ok ${(await ops.hasMedia(dec(name))) ? 1 : 0}`;
  },
  async readMedia([name]) {
    return `ok ${hex(await ops.readMedia(dec(name)))}`;
  },
  async addMedia([name, bytes]) {
    return `ok ${enc(await ops.addMedia(dec(name), unhex(bytes)))}`;
  },
  async createNotetype([name, fields, templates, css, requirements, media]) {
    const spec = {
      name: dec(name),
      fields: items(fields).map(dec),
      templates: items(templates).map((t) => {
        const [tn, front, back] = dec(t).split(' ');
        return { name: dec(tn), front: dec(front), back: dec(back) };
      }),
      css: dec(css),
      requirements: items(requirements).map((r) => {
        const [ord, kind, ords] = dec(r).split(' ');
        return { ord: Number(ord), kind: dec(kind), fields: items(ords).map(Number) };
      }),
    };
    const files = {};
    for (const m of items(media)) {
      const [mn, bytes] = dec(m).split(' ');
      files[dec(mn)] = unhex(bytes);
    }
    const r = await ops.createNotetype(spec, files);
    return `ok ${r.created ? 1 : 0} ${r.notetypeId ?? '!'} ${enc(r.reason)}`;
  },
};

async function run(line, more) {
  const [verb, ...args] = line.split(' ');
  const command = COMMANDS[verb];
  if (!command) return `err error ${enc(`unknown command ${verb}`)}`;
  try {
    return await command(args, more);
  } catch (error) {
    return failure(error);
  }
}

// Lines in, answers out, in order. A command that takes lines after it (addNotesBulk, parallel)
// says how many in its first argument.
const input = readline.createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const next = async () => (await lines.next()).value;
for (;;) {
  const line = await next();
  if (line === undefined || line === 'quit') break;
  const [verb, count] = line.split(' ');
  if (verb === 'addNotesBulk') {
    const more = [];
    for (let i = 0; i < Number(count); i += 1) more.push(await next());
    process.stdout.write(`${await run(line, more)}\n`);
  } else if (verb === 'parallel') {
    const commands = [];
    for (let i = 0; i < Number(count); i += 1) commands.push(await next());
    // All at once, as concurrent requests reach the server: the lock chain is what orders them.
    const answers = await Promise.all(commands.map((c) => run(c, [])));
    process.stdout.write(`${answers.join('\n')}\n`);
  } else {
    process.stdout.write(`${await run(line, [])}\n`);
  }
}
