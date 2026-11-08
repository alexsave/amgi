// Collection parity: one operation list, applied to a copy of each fixture collection (schema 11
// and schema 18, test/parity/fixtures, made by real Anki with make_fixtures.py), through an
// implementation of the collection core driven over test/parity/protocol.mjs. Every answer goes
// into a transcript, and the collection afterwards (every row, the schema text, the media folder,
// the backups) is dumped by server/build/parity_dump (test/parity/dump.c); both, with ids and
// times normalised, must equal what was recorded from today's Node code in test/parity/expect/.
//
// The implementation is chosen by environment variable, so the same runner checks the C port:
//   AMGI_COLLECTION_IMPL unset            node test/parity/collection-impl.mjs (the Node code)
//   AMGI_COLLECTION_IMPL=<executable>     that program, speaking the same protocol (the C CLI)
// PARITY_RECORD=1 writes the expectations from the implementation under test instead of comparing
// (do it only from the Node one, and read the diff).
//
// The sessions that need the real Anki library (a real lock held by Anki, a change Anki makes
// between two of ours, and opening each result with Anki) skip when no python with `anki` is
// found (ANKI_PYTHON_BIN, as the rest of the suite).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dec, enc, hex, items, list, noteTokens, num, strs, unhex } from './protocol.mjs';
import { collectionDrift, installNotetypeDirect } from '../../src/server/anki/install.js';
import { buildStarterDeck } from '../../src/server/anki/starterDeck.js';

const require = createRequire(import.meta.url);
const { anki, holdCollectionOpen, runPython } = require('../../plusaudio/test/collection/helpers/anki-python.js');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HERE = path.join(ROOT, 'test', 'parity');
const DUMP = path.join(ROOT, 'server', 'build', 'parity_dump');
const RECORD = process.env.PARITY_RECORD === '1';
const IMPL = process.env.AMGI_COLLECTION_IMPL;

export function implCommand() {
  return IMPL
    ? [IMPL, []]
    : [process.execPath, ['--import', './ui/server/hooks.mjs', 'test/parity/collection-impl.mjs']];
}

/** One implementation process: one server session, as the ledger and the lock chains see it. */
export class Impl {
  constructor() {
    const [cmd, args] = implCommand();
    this.child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.waiting = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  drain() {
    while (this.waiting.length) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.waiting.shift()(line);
    }
  }

  line() {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.drain();
    });
  }

  /** How many lines follow an answer's first line. */
  static following(verb, first) {
    const t = first.split(' ');
    if (t[0] !== 'ok') return 0;
    if (verb === 'listDecks' || verb === 'listNotetypes' || verb === 'addNotesBulk') return Number(t[1]);
    if (verb === 'listNotesInDeck') return Number(t[4]);
    return 0;
  }

  async answer(verb) {
    const first = await this.line();
    const rest = [];
    for (let i = Impl.following(verb, first); i > 0; i -= 1) rest.push(await this.line());
    return [first, ...rest].join('\n');
  }

  /** Send a command (and the lines it carries) and read its whole answer. */
  async cmd(line, more = []) {
    this.child.stdin.write(`${[line, ...more].join('\n')}\n`);
    return this.answer(line.split(' ')[0]);
  }

  /** Several single-line commands at once; their answers in order. */
  async parallel(lines) {
    this.child.stdin.write(`parallel ${lines.length}\n${lines.join('\n')}\n`);
    const answers = [];
    for (const line of lines) answers.push(await this.answer(line.split(' ')[0]));
    return answers;
  }

  async close() {
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end('quit\n');
    await exited;
  }
}

/** A thrown answer, shaped as directClient's errors are (kind, or an HTTP status). */
function errorOf(answer) {
  const [, kind, message] = answer.split(' ');
  const error = new Error(dec(message));
  const k = dec(kind);
  if (/^\d+$/.test(k)) error.status = Number(k);
  else if (k !== 'error') error.kind = k;
  return error;
}

function okTokens(answer) {
  if (!answer.startsWith('ok')) throw errorOf(answer);
  return answer.split('\n')[0].split(' ').slice(1);
}

/**
 * The ops shape the server's own orchestration takes (src/server/anki/install.js, starterDeck.js),
 * answered by an implementation over the protocol: so the install's collection checks and the
 * starter deck run through the collection core under test, unchanged.
 */
export function opsOver(impl, log) {
  const call = async (line, more = []) => {
    const answer = await impl.cmd(line, more);
    log(line, more, answer);
    return answer;
  };
  return {
    async listNotetypes() {
      const answer = await call('listNotetypes');
      okTokens(answer);
      return answer.split('\n').slice(1).map((row) => {
        const [id, name, kind, sortf, fields, templates] = row.split(' ');
        return {
          id: Number(id), name: dec(name), kind: dec(kind), sortFieldIndex: Number(sortf),
          fieldNames: items(fields).map(dec),
          templates: items(templates).map((t) => {
            const [ord, tn, q, a] = dec(t).split(' ');
            return { ord: Number(ord), name: dec(tn), questionFormat: dec(q), answerFormat: dec(a) };
          }),
        };
      });
    },
    async readMedia(name) {
      return unhex(okTokens(await call(`readMedia ${enc(name)}`))[0]);
    },
    async hasMedia(name) {
      return okTokens(await call(`hasMedia ${enc(name)}`))[0] === '1';
    },
    async addMedia(name, data) {
      return dec(okTokens(await call(`addMedia ${enc(name)} ${hex(data)}`))[0]);
    },
    async createDeck(name) {
      const [id, n, created] = okTokens(await call(`createDeck ${enc(name)}`));
      return { deck: { id: Number(id), name: dec(n) }, created: created === '1' };
    },
    async existingFieldValues(deck, notetype, field) {
      return items(okTokens(await call(`existingFieldValues ${deck} ${notetype} ${field}`))[0]).map(dec);
    },
    async addNote(note) {
      const [noteId, guid, cardIds, warning] = okTokens(await call(`addNote ${noteTokens(note)}`));
      const r = { noteId: Number(noteId), guid: dec(guid), cardIds: items(cardIds).map(Number) };
      if (warning !== '!') r.warning = dec(warning);
      return r;
    },
    async createNotetype(spec, media) {
      const line = [
        'createNotetype', enc(spec.name), strs(spec.fields),
        list(spec.templates.map((t) => enc([enc(t.name), enc(t.front), enc(t.back)].join(' ')))),
        enc(spec.css),
        list((spec.requirements || []).map((r) => enc([r.ord, enc(r.kind), list(r.fields.map(String))].join(' ')))),
        list(Object.entries(media).map(([n, bytes]) => enc(`${enc(n)} ${hex(bytes)}`))),
      ].join(' ');
      const [created, id, reason] = okTokens(await call(line));
      const r = { created: created === '1' };
      if (id !== '!') r.notetypeId = Number(id);
      if (reason !== '!') r.reason = dec(reason);
      return r;
    },
  };
}

/** A copy of a fixture as one profile ("User 1") under a fresh Anki folder. */
function freshCopy(schema) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `amgi-parity-${schema}-`));
  const profile = path.join(base, 'User 1');
  fs.cpSync(path.join(HERE, 'fixtures', `schema${schema}`), profile, { recursive: true });
  return { base, profile, collection: path.join(profile, 'collection.anki2') };
}

/**
 * Normalising a transcript. An integer inside the run's window is an id or a time made during the
 * run: where the protocol says which kind of id a token is (a deck, a note type, a note, a card),
 * it becomes <D1>, <N2>, ... numbered by first appearance within its kind; a note's guid becomes
 * <guid>. Any other number in the window is looked up among the ids seen, or else is a time, <T>.
 * Two implementations that make the same rows in the same order give the same text, however their
 * clocks collide (a note and its card made in the same millisecond share a number).
 */
const ARG_KINDS = {
  countNotesInDeck: ['D'], listNotesInDeck: ['D'], existingFieldValues: ['D', 'M'], renameDeck: ['D'],
  deckRemovalSummary: ['D'], removeDeck: ['D'], addNote: ['D', 'M'], updateNote: ['N'], removeNote: ['N'],
};
const ANSWER_KINDS = {
  createDeck: ['D'], renameDeck: ['D'], deckRemovalSummary: ['D'], removeDeck: ['D'], addNote: ['N', 'G', ['C']],
  removeNote: ['N'], createNotetype: [null, 'M'],
};
const ROW_KINDS = {
  listDecks: ['D'], listNotetypes: ['M'], listNotesInDeck: ['N', 'M'], addNotesBulk: [null, 'N', 'G', ['C']],
};
const NOTE_KINDS = ['D', 'M'];

export function transcriptNormaliser(since, until) {
  const maps = { D: new Map(), M: new Map(), N: new Map(), C: new Map() };
  const inWindow = (v) => (v >= since && v <= until + 60000)
    || (v >= Math.floor(since / 1000) && v <= Math.floor(until / 1000) + 60);
  const typed = (token, kind) => {
    if (kind === null || kind === undefined) return token;
    if (kind === 'G') return '<guid>';
    if (Array.isArray(kind)) return token.startsWith('[') ? list(items(token).map((t) => typed(t, kind[0]))) : token;
    if (!/^\d+$/.test(token) || !inWindow(Number(token))) return token;
    const map = maps[kind];
    if (!map.has(token)) map.set(token, `<${kind}${map.size + 1}>`);
    return map.get(token);
  };
  // A %XX escape is one unit, so the "20" of an escaped space never starts a number.
  const loose = (text) => text.replace(/%[0-9A-F]{2}|\d{9,}/g, (digits) => {
    if (digits.startsWith('%') || !inWindow(Number(digits))) return digits;
    for (const map of Object.values(maps)) if (map.has(digits)) return map.get(digits);
    return '<T>';
  });
  const line = (tokens, kinds) => tokens.map((t, i) => typed(t, kinds[i])).join(' ');
  return {
    command(verb, text, more) {
      const [v, ...args] = text.split(' ');
      const out = [line([v, ...args], [null, ...(ARG_KINDS[verb] || [])])];
      for (const m of more) out.push(line(m.split(' '), NOTE_KINDS));
      return out.map((l) => `> ${loose(l)}`).join('\n');
    },
    answer(verb, text) {
      const [first, ...rows] = text.split('\n');
      const out = [first.startsWith('ok') ? line(first.split(' '), [null, ...(ANSWER_KINDS[verb] || [])]) : first];
      for (const row of rows) out.push(line(row.split(' '), ROW_KINDS[verb] || []));
      return loose(out.join('\n'));
    },
    loose,
  };
}

/** Everything a session left, as the dump prints it. */
function dumpOf(copy, since, until) {
  const backups = path.join(copy.profile, 'amgi-collection-backups');
  // The dump opens what it reads; give it copies, so nothing it does lands in the record.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-parity-dump-'));
  fs.cpSync(copy.profile, scratch, { recursive: true });
  const out = execFileSync(DUMP, ['--since', String(since), '--until', String(until), path.join(scratch, 'collection.anki2'),
    path.join(scratch, 'collection.media'), path.join(scratch, 'amgi-collection-backups')], { encoding: 'utf8', maxBuffer: 256 << 20 });
  fs.rmSync(scratch, { recursive: true, force: true });
  void backups;
  return out;
}

/** The deck ids by name, as listDecks answers them. */
async function deckIds(impl) {
  const answer = await impl.cmd('listDecks');
  const ids = {};
  for (const row of answer.split('\n').slice(1)) {
    const [id, name] = row.split(' ');
    ids[dec(name)] = Number(id);
  }
  return ids;
}

async function notetypeIds(impl) {
  const answer = await impl.cmd('listNotetypes');
  const ids = {};
  for (const row of answer.split('\n').slice(1)) {
    const [id, name] = row.split(' ');
    ids[dec(name)] = Number(id);
  }
  return ids;
}

/** A result object as one line, for the transcript (key=value, lists in brackets). */
function show(value) {
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${k}=${show(v)}`).join(' ')}}`;
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

const note = (deckId, notetypeId, fields, extra = {}) => noteTokens({ deckId, notetypeId, fields, tags: [], ...extra });
const firstId = (answer) => Number(answer.split(' ')[1]);

/**
 * The operation list: every collection operation the server makes, with the cases each one's code
 * branches on. `t.cmd` sends one command and records it with its answer.
 */
async function operations(t, impl, schema) {
  await t.cmd('status');
  const decks = await deckIds(impl);
  const nts = await notetypeIds(impl);
  t.note(`decks ${Object.keys(decks).length}, note types ${Object.keys(nts).length}`);
  await t.cmd('listDecks');
  for (const id of Object.values(decks)) await t.cmd(`countNotesInDeck ${id}`);
  await t.cmd('listNotetypes');
  const basic = nts.Basic;
  const reversed = nts['Basic (and reversed card)'];
  const cloze = nts.Cloze;
  const retro = nts["Retro's sentences"];

  // Reads: paging (subdecks included), field values, a deck that is not there.
  for (const [offset, limit] of [[0, 2], [2, 2], [4, 2], [0, 200], [50, 10]]) {
    await t.cmd(`listNotesInDeck ${decks.Existing} ${offset} ${limit}`);
  }
  await t.cmd(`listNotesInDeck 999 0 50`);
  await t.cmd(`existingFieldValues ${decks.Existing} ${basic} 0`);
  await t.cmd(`existingFieldValues ${decks.Existing} ${basic} 5`);
  await t.cmd(`existingFieldValues ${decks.Korean} ${retro} 2`);
  await t.cmd(`existingFieldValues 999 ${basic} 0`);
  await t.cmd(`countNotesInDeck 999`);

  // Decks: find or create, ancestors, case folding, names Anki normalises.
  const created = firstId(await t.cmd(`createDeck ${enc('New Deck')}`));
  await t.cmd(`createDeck ${enc('new deck')}`);
  await t.cmd(`createDeck ${enc('Parent::Child::Grand')}`);
  await t.cmd(`createDeck ${enc('Parent::Child')}`);
  await t.cmd(`createDeck ${enc('  Trim me  ::  inner  ')}`);
  await t.cmd(`createDeck ${enc('A::::B')}`);
  await t.cmd(`createDeck ${enc('CAFÉ')}`);
  await t.cmd(`createDeck ${enc('Straße')}`);
  await t.cmd(`createDeck ${enc('STRASSE')}`);
  await t.cmd(`createDeck ${enc('Ctl\u0001Char\u007f')}`);
  await t.cmd(`createDeck ${enc('Korean::문장')}`);
  await t.cmd(`createDeck ${enc('Café decomposed')}`);
  await t.cmd(`createDeck ${enc('::')}`);
  const after = await deckIds(impl);

  // Notes: cards from templates, cloze numbers, the romanisation warning, checksums of markup.
  const a = firstId(await t.cmd(`addNote ${note(created, basic, ['front a', 'back a'])}`));
  await t.cmd(`addNote ${note(created, basic, ['tagged', 'b'], { tags: ['t1', 'amgi'] })}`);
  await t.cmd(`addNote ${note(created, basic, ['annyeong', 'hello'], { language: 'ko', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['안녕', 'hello'], { language: 'ko', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['konnichiwa', 'x'], { language: 'ja', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['hola', 'x'], { language: 'es', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['x', 'privet'], { language: 'ru', learningFieldIndex: 1 })}`);
  await t.cmd(`addNote ${note(created, basic, ['  ', 'x'], { language: 'ko', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['x', 'y'], { language: 'ko', learningFieldIndex: 7 })}`);
  await t.cmd(`addNote ${note(created, basic, ['<b>Hi</b> &amp; <img src="pic.png"> &#x41;&nbsp;x &#66; &bogus; <!-- c --> <audio src=\'a.wav\'>', '<i>b</i>'])}`);
  await t.cmd(`addNote ${note(created, basic, ['<IMG SRC=bare.jpg alt=x>', ''])}`);
  await t.cmd(`addNote ${note(created, reversed, ['only front', ''])}`);
  await t.cmd(`addNote ${note(created, reversed, ['both', 'sides'])}`);
  await t.cmd(`addNote ${note(created, cloze, ['{{c1::one}} {{c3::three}} {{c3::again}}', ''])}`);
  await t.cmd(`addNote ${note(created, cloze, ['no cloze here', 'extra'])}`);
  await t.cmd(`addNote ${note(created, cloze, ['{{c0::zero}} {{c600::big}}', ''])}`);
  await t.cmd(`addNote ${note(created, retro, ['문장', '', 'sort'])}`);
  await t.cmd(`addNote ${note(created, basic, ['wrong count'])}`);
  await t.cmd(`addNote ${note(created, 4242, ['x', 'y'])}`);
  await t.cmd(`addNote ${note(created, basic, ['', ''])}`);
  await t.cmd(`addNote ${note(created, basic, ['emoji 🙂 and 漢字', 'x'], { language: 'zh_cn', learningFieldIndex: 0 })}`);

  // A paste: one write, one result per note, a bad one in the middle.
  await t.cmd('addNotesBulk 4', [
    note(created, basic, ['bulk 1', 'x']), note(created, basic, ['bulk bad']),
    note(created, basic, ['bulk 3', 'x'], { language: 'ko', learningFieldIndex: 0 }), note(created, cloze, ['{{c2::bulk}}', '']),
  ]);
  await t.cmd(`addNotesBulk 1`, [note(created, 4242, ['x', 'y'])]);

  // Edits and deletes.
  await t.cmd(`updateNote ${a} ${strs(['front a2', 'back <b>a2</b>'])} ! !`);
  await t.cmd(`updateNote ${a} ${strs(['romaji', 'x'])} ja 0`);
  await t.cmd(`updateNote ${a} ${strs(['too', 'many', 'fields'])} ! !`);
  await t.cmd(`updateNote 999 ${strs(['x', 'y'])} ! !`);
  const doomed = firstId(await t.cmd(`addNote ${note(created, reversed, ['to delete', 'both'])}`));
  await t.cmd(`removeNote ${doomed}`);
  await t.cmd(`removeNote ${doomed}`);
  await t.cmd(`removeNote 999`);

  // Renames: subdecks move, a missing parent is made, a taken name is refused.
  await t.cmd(`renameDeck ${created} ${enc('Renamed')}`);
  await t.cmd(`renameDeck ${created} ${enc('renamed')}`);
  await t.cmd(`renameDeck ${after.Parent} ${enc('Moved::Parent')}`);
  await t.cmd(`renameDeck ${created} ${enc('Existing')}`);
  await t.cmd(`renameDeck ${created} ${enc('EXISTING::child')}`);
  await t.cmd(`renameDeck 999 ${enc('Nowhere')}`);
  await t.cmd(`renameDeck ${after['Straße']} ${enc('Sub::Deep::Straße')}`);
  await t.cmd(`renameDeck ${decks.Korean} ${enc('한국어')}`);
  await t.cmd('listDecks');

  // Media: a new name, the same bytes again, other bytes under a taken name, names cleaned.
  await t.cmd(`addMedia ${enc('clip.wav')} ${hex(Buffer.from('first take'))}`);
  await t.cmd(`addMedia ${enc('clip.wav')} ${hex(Buffer.from('first take'))}`);
  await t.cmd(`addMedia ${enc('clip.wav')} ${hex(Buffer.from('second take'))}`);
  await t.cmd(`addMedia ${enc('Clip.WAV')} ${hex(Buffer.from('third take'))}`);
  await t.cmd(`addMedia ${enc('Upper.ogg')} ${hex(Buffer.from('upper'))}`);
  await t.cmd(`addMedia ${enc('upper.ogg')} ${hex(Buffer.from('upper'))}`);
  await t.cmd(`addMedia ${enc('../escape.wav')} ${hex(Buffer.from('escape'))}`);
  await t.cmd(`addMedia ${enc('dir/sub.wav')} ${hex(Buffer.from('sub'))}`);
  await t.cmd(`addMedia ${enc('ctl\u0001name.wav')} ${hex(Buffer.from('ctl'))}`);
  await t.cmd(`addMedia ${enc('noext')} ${hex(Buffer.from('a'))}`);
  await t.cmd(`addMedia ${enc('noext')} ${hex(Buffer.from('b'))}`);
  await t.cmd(`addMedia ${enc('..')} ${hex(Buffer.from('x'))}`);
  await t.cmd(`addMedia ${enc('\u0001')} ${hex(Buffer.from('x'))}`);
  await t.cmd(`addMedia ${enc('café.wav')} ${hex(Buffer.from('nfc'))}`);
  await t.cmd(`addMedia ${enc('empty.wav')} ~`);
  for (const name of ['clip.wav', 'clip.ogg', 'nope.wav', '../clip.ogg', '', 'café.wav']) await t.cmd(`hasMedia ${enc(name)}`);
  for (const name of ['clip.wav', 'clip.ogg', 'nope.wav', '../clip.ogg', 'a/b', '..', '.', '', 'a\0b', 'a\\b', 'empty.wav']) {
    await t.cmd(`readMedia ${enc(name)}`);
  }

  // Deleting decks: what it would take, the Default deck, a filtered deck (its cards go home), a
  // tree with a note that keeps a card elsewhere, one already gone.
  await t.cmd(`deckRemovalSummary ${decks.Existing}`);
  await t.cmd(`deckRemovalSummary ${decks.Filtered}`);
  await t.cmd(`deckRemovalSummary ${decks.Korean}`);
  await t.cmd(`deckRemovalSummary 1`);
  await t.cmd(`deckRemovalSummary 999`);
  await t.cmd(`removeDeck 1`);
  await t.cmd(`removeDeck ${decks.Filtered}`);
  await t.cmd(`removeDeck ${decks.Existing}`);
  await t.cmd(`removeDeck ${decks.Existing}`);
  await t.cmd(`removeDeck 999`);
  await t.cmd(`removeDeck ${decks.Empty}`);
  const doomed2 = firstId(await t.cmd(`createDeck ${enc('Doomed::Sub')}`));
  await t.cmd(`addNote ${note(doomed2, basic, ['doomed', 'x'])}`);
  // A field holding Anki's field separator: the Node code writes it as it is, so the note reads
  // back with one field too many (a known Node bug, kept here so the port matches it until it is
  // fixed on both sides). In a deck that goes, so the collection Anki checks below stays whole.
  await t.cmd(`addNote ${note(doomed2, basic, ['sep\u001fin field', 'x'])}`);
  await t.cmd(`removeDeck ${(await deckIds(impl)).Doomed}`);
  await t.cmd('listDecks');

  // Install's collection checks and the note type the direct install writes, then the starter
  // deck, both run by the server's own orchestration over the implementation's ops.
  const ops = opsOver(impl, (line, more, answer) => t.record(line, more, answer));
  t.note(`drift before install: ${show(await collectionDrift({ ops, root: ROOT }))}`);
  t.note(`install: ${show(await installNotetypeDirect({ ops, root: ROOT }))}`);
  t.note(`drift after install: ${show(await collectionDrift({ ops, root: ROOT }))}`);
  t.note(`install again: ${show(await installNotetypeDirect({ ops, root: ROOT }))}`);
  for (const [known, learning] of [['en', 'ko'], ['en', 'ko'], ['ko', 'ja']]) {
    try {
      const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
      t.note(`starter ${known}/${learning}: ${show(built)}`);
    } catch (error) {
      t.note(`starter ${known}/${learning} failed: ${error.message}`);
    }
  }

  // Concurrent writes, as five bulk lanes and a status poll reach one server at once.
  const lines = [];
  for (let i = 0; i < 6; i += 1) lines.push(`addNote ${note(decks['Korean::문장'], basic, [`parallel ${i}`, 'x'])}`);
  lines.push('status', `countNotesInDeck ${decks.Korean}`);
  const answers = await impl.parallel(lines);
  // Their order of landing is the scheduler's; what is recorded is that each one worked.
  t.note(`parallel: ${answers.map((x) => x.split(' ')[0]).join(' ')}`);
  await t.cmd(`existingFieldValues ${decks['Korean::문장']} ${basic} 0`);
  await t.cmd('status');
  void schema;
}

/** A session: a fresh fixture copy, a fresh implementation, the transcript and the dump. */
async function session(schema, body) {
  const copy = freshCopy(schema);
  const since = Date.now();
  const impl = new Impl();
  const entries = [];
  const t = {
    copy,
    record(line, more, answer) {
      entries.push({ line, more, answer });
    },
    async cmd(line, more = []) {
      const answer = await impl.cmd(line, more);
      this.record(line, more, answer);
      return answer;
    },
    note(text) {
      entries.push({ note: text });
    },
  };
  await impl.cmd(`open ${enc(copy.collection)}`);
  try {
    await body(t, impl);
  } finally {
    await impl.close();
  }
  const until = Date.now();
  const norm = transcriptNormaliser(since, until);
  const transcript = entries.map((e) => {
    if (e.note !== undefined) return `# ${norm.loose(e.note)}`;
    const verb = e.line.split(' ')[0];
    return `${norm.command(verb, e.line, e.more)}\n${norm.answer(verb, e.answer)}`;
  }).join('\n').replaceAll(enc(copy.base), '<base>');
  const dump = dumpOf(copy, since, until);
  return { copy, transcript, dump, since, until };
}

function expectFile(name) {
  return path.join(HERE, 'expect', `${name}.txt`);
}

/** Compare against the recording (or write it), line by line, so a failure shows where. */
function check(name, text) {
  const file = expectFile(name);
  if (RECORD) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `${file} is recorded (PARITY_RECORD=1 from the Node implementation)`);
  const want = fs.readFileSync(file, 'utf8').split('\n');
  const got = text.split('\n');
  for (let i = 0; i < Math.max(want.length, got.length); i += 1) {
    if (want[i] !== got[i]) {
      assert.fail(`${name}: line ${i + 1} differs\n  recorded: ${want[i]}\n  this run: ${got[i]}\n`
        + `context:\n${got.slice(Math.max(0, i - 3), i + 3).join('\n')}`);
    }
  }
}

/** What real Anki makes of a session's collection: it opens it, and Check Database is clean. */
function ankiCheck(collection) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-parity-anki-'));
  fs.cpSync(path.dirname(collection), scratch, { recursive: true });
  const out = runPython(`
import sys
from anki.collection import Collection
col = Collection(sys.argv[1])
print("schema", col.db.scalar("select ver from col"))
print("integrity", col.db.scalar("pragma integrity_check"))
print("decks", sorted(d.name for d in col.decks.all_names_and_ids()))
print("notetypes", sorted(n.name for n in col.models.all_names_and_ids()))
print("notes", col.note_count(), "cards", col.card_count())
for nid in col.find_notes(""):
    n = col.get_note(nid)
    assert len(n.fields) == len(n.note_type()["flds"]), nid
problems, ok = col.fix_integrity()
print("check database", ok, problems)
col.close()
`, [path.join(scratch, 'collection.anki2')]);
  fs.rmSync(scratch, { recursive: true, force: true });
  return out;
}

before(() => {
  execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'), 'build/parity_dump'], { stdio: 'inherit' });
});

for (const schema of ['18', '11']) {
  describe(`collection parity, schema ${schema}${IMPL ? ` (${path.basename(IMPL)})` : ' (Node)'}`, () => {
    let main;
    test('the operation list: every answer, and every row afterwards', async () => {
      main = await session(schema, (t, impl) => operations(t, impl, schema));
      check(`collection-${schema}-transcript`, main.transcript);
      check(`collection-${schema}-dump`, main.dump);
    });

    test('one backup for the whole session, however many writes', () => {
      const backups = fs.readdirSync(path.join(main.copy.profile, 'amgi-collection-backups'));
      assert.equal(backups.length, 1, backups.join(', '));
    });

    test('the result opens in real Anki, and Check Database finds nothing', { skip: !anki && 'needs ANKI_PYTHON_BIN' }, () => {
      const out = ankiCheck(main.copy.collection);
      assert.match(out, /^integrity ok$/m);
      check(`collection-${schema}-anki`, out);
    });

    test('a collection Anki holds open: locked, nothing written, nothing copied but for media', { skip: !anki && 'needs ANKI_PYTHON_BIN' }, async () => {
      let holder;
      const s = await session(schema, async (t, impl) => {
        holder = holdCollectionOpen(t.copy.collection);
        await holder.held;
        await t.cmd('status');
        await t.cmd('listDecks');
        await t.cmd(`createDeck ${enc('While locked')}`);
        await t.cmd(`addNote ${note(1, 1, ['x', 'y'])}`);
        await t.cmd(`removeDeck 2`);
        await t.cmd(`hasMedia ${enc('clip.ogg')}`);
        await t.cmd(`readMedia ${enc('clip.ogg')}`);
        await t.cmd(`addMedia ${enc('locked.wav')} ${hex(Buffer.from('while locked'))}`);
        await holder.release();
        await t.cmd('status');
        await t.cmd(`createDeck ${enc('After release')}`);
        await t.cmd(`createDeck ${enc('After release 2')}`);
      });
      check(`collection-${schema}-locked-transcript`, s.transcript);
      check(`collection-${schema}-locked-dump`, s.dump);
    });

    test('a change Anki makes between two of ours takes a second backup, and only then', { skip: !anki && 'needs ANKI_PYTHON_BIN' }, async () => {
      const s = await session(schema, async (t) => {
        await t.cmd(`createDeck ${enc('Ours 1')}`);
        await t.cmd(`createDeck ${enc('Ours 2')}`);
        runPython(`
import sys
from anki.collection import Collection
col = Collection(sys.argv[1])
col.decks.id("Theirs")
col.close(downgrade=${schema === '11' ? 'True' : 'False'})
`, [t.copy.collection]);
        t.note('Anki added a deck');
        await t.cmd(`createDeck ${enc('Ours 3')}`);
        await t.cmd(`createDeck ${enc('Ours 4')}`);
      });
      const backups = fs.readdirSync(path.join(s.copy.profile, 'amgi-collection-backups'));
      assert.equal(backups.length, 2, backups.join(', '));
      check(`collection-${schema}-external-transcript`, s.transcript);
    });
  });
}

describe(`collection parity: collections that cannot be opened${IMPL ? ` (${path.basename(IMPL)})` : ' (Node)'}`, () => {
  test('missing, not a collection, and an unsupported schema', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-parity-bad-'));
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(path.join(dir, 'old.anki2'));
    old.exec('CREATE TABLE col (id integer primary key, ver integer); INSERT INTO col VALUES (1, 5);');
    old.close();
    fs.writeFileSync(path.join(dir, 'junk.anki2'), 'not a database at all, just some text that is long enough to be read');
    const impl = new Impl();
    const lines = [];
    for (const file of ['missing.anki2', 'old.anki2', 'junk.anki2']) {
      lines.push(`> open ${file}`, await impl.cmd(`open ${enc(path.join(dir, file))}`));
    // (Media is left out: the server never reaches a collection it cannot open, so what the media
    // calls do with one is not behaviour anybody sees.)
      for (const c of ['status', 'listDecks', `createDeck ${enc('x')}`, `addNote ${note(1, 1, ['x', 'y'])}`]) {
        lines.push(`> ${c}`, await impl.cmd(c));
      }
    }
    await impl.close();
    check('collection-unopenable', lines.join('\n'));
  });
});
