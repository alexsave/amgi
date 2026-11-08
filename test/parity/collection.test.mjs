// Collection parity: one operation list, applied to a copy of each fixture collection (schema 11
// and schema 18, test/parity/fixtures, made by real Anki with make_fixtures.py), through an
// implementation of the collection core driven over test/parity/protocol.mjs. Every answer goes
// into a transcript, and the collection afterwards (every row, the schema text, the media folder,
// the backups) is dumped by server/build/parity_dump (test/parity/dump.c); both, with ids and
// times normalised, must equal test/parity/expect/: the contract's golden answers. They were recorded
// from the Node code the C core replaced and are now the C core's (test/parity/impl-process.mjs runs
// server/build/collection_cli): where C answers differently on purpose (PR #30's review fixes: the
// first field's checksum stripped once, as Anki does; hasMedia refusing what readMedia refuses) its
// answer is the recording, and the install and starter steps are the server's own C orchestration,
// run by the CLI in the same session.
//
//
// The sessions that need the real Anki library (a real lock held by Anki, a change Anki makes
// between two of ours, and opening each result with Anki) skip when no python with `anki` is
// found (ANKI_PYTHON_BIN, as the rest of the suite).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dec, enc, hex, items, list, noteTokens, strs } from './protocol.mjs';

const require = createRequire(import.meta.url);
const { anki, holdCollectionOpen, runPython } = require('../../plusaudio/test/collection/helpers/anki-python.js');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HERE = path.join(ROOT, 'test', 'parity');
const DUMP = path.join(ROOT, 'server', 'build', 'parity_dump');

import { Impl } from './impl-process.mjs';

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
  // Still markup-like after one strip: its checksum is where C (stripping once, as Anki) and the
  // Node that this replaced (stripping twice) part.
  await t.cmd(`addNote ${note(created, basic, ['<b>&lt;i&gt;</b>', 'csum'])}`);
  await t.cmd(`addNote ${note(created, reversed, ['only front', ''])}`);
  await t.cmd(`addNote ${note(created, reversed, ['both', 'sides'])}`);
  await t.cmd(`addNote ${note(created, cloze, ['{{c1::one}} {{c3::three}} {{c3::again}}', ''])}`);
  await t.cmd(`addNote ${note(created, cloze, ['no cloze here', 'extra'])}`);
  await t.cmd(`addNote ${note(created, cloze, ['{{c0::zero}} {{c600::big}}', ''])}`);
  await t.cmd(`addNote ${note(created, retro, ['문장', '', 'sort'])}`);
  await t.cmd(`addNote ${note(created, basic, ['wrong count'])}`);
  await t.cmd(`addNote ${note(created, 4242, ['x', 'y'])}`);
  await t.cmd(`addNote ${note(created, basic, ['', ''])}`);
  // Field text as Anki stores it (deck.js ankiFields): ASCII control characters but tab and line
  // feed removed, the field separator 0x1f among them, then NFC.
  await t.cmd(`addNote ${note(created, basic, ['sep\u001fin field', 'x'])}`);
  await t.cmd(`addNote ${note(created, basic, ['\u0000nul \u0001\u0008 \u000b\u000c\r\n\t \u001b esc \u007f del', 'cr\r\nlf'])}`);
  await t.cmd(`addNote ${note(created, basic, ['cafe\u0301 decomposed', '\u1100\u1161 jamo'])}`);
  await t.cmd(`addNote ${note(created, basic, ['\u0085 next line and \u00a0nbsp stay', '<b>html</b>\u001f'])}`);
  await t.cmd(`addNote ${note(created, basic, ['\u001f', 'only a separator'])}`);
  await t.cmd(`addNote ${note(created, reversed, ['\u0001', '\u0002'])}`);
  await t.cmd(`addNote ${note(created, basic, ['annye\u0001ong', 'x'], { language: 'ko', learningFieldIndex: 0 })}`);
  await t.cmd(`addNote ${note(created, basic, ['emoji 🙂 and 漢字', 'x'], { language: 'zh_cn', learningFieldIndex: 0 })}`);

  // A paste: one write, one result per note, a bad one in the middle.
  await t.cmd('addNotesBulk 4', [
    note(created, basic, ['bulk 1', 'x']), note(created, basic, ['bulk bad']),
    note(created, basic, ['bulk 3', 'x'], { language: 'ko', learningFieldIndex: 0 }), note(created, cloze, ['{{c2::bulk}}', '']),
  ]);
  await t.cmd('addNotesBulk 2', [note(created, basic, ['bulk\u001fsep', 'e\u0301']), note(created, basic, ['bulk\u0000nul', '\r'])]);
  await t.cmd(`addNotesBulk 1`, [note(created, 4242, ['x', 'y'])]);

  // Edits and deletes.
  await t.cmd(`updateNote ${a} ${strs(['front a2', 'back <b>a2</b>'])} ! !`);
  await t.cmd(`updateNote ${a} ${strs(['romaji', 'x'])} ja 0`);
  await t.cmd(`updateNote ${a} ${strs(['too', 'many', 'fields'])} ! !`);
  await t.cmd(`updateNote ${a} ${strs(['edited\u001fsep\u0007', 'cafe\u0301\r\n'])} ! !`);
  await t.cmd(`listNotesInDeck ${created} 0 3`);
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
  await t.cmd(`removeDeck ${(await deckIds(impl)).Doomed}`);
  await t.cmd('listDecks');

  // Install's collection checks and the note type the direct install writes, then the starter
  // deck: the server's own orchestration (server/amgi/install.c, starter.c), run by the CLI over
  // this collection in the same session.
  await t.cmd('installDrift');
  await t.cmd('installNotetype');
  await t.cmd('installDrift');
  await t.cmd('installNotetype');
  for (const [known, learning] of [['en', 'ko'], ['en', 'ko'], ['ko', 'ja']]) {
    await t.cmd(`starter ${enc(known)} ${enc(learning)} ${enc('amgi starter')}`);
  }

  // Concurrent writes, as five bulk lanes and a status poll reach one server at once.
  const lines = [];
  // The same note six times: which lands first is the scheduler's, so nothing recorded may depend on it.
  for (let i = 0; i < 6; i += 1) lines.push(`addNote ${note(decks['Korean::문장'], basic, ['parallel', 'x'])}`);
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
    impl,
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

/** Compare against the recording, line by line, so a failure shows where. */
function check(name, text) {
  const file = expectFile(name);
  assert.ok(fs.existsSync(file), `${file} is recorded`);
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

/**
 * The dump tool is C (server/Makefile: a C compiler, sqlite and ICU). Built here, once; on a machine
 * that cannot build it, the sessions that need it skip with this sentence rather than fail, so
 * npm test still runs everything else. AMGI_REQUIRE_NATIVE=1 makes that a failure instead, for a
 * machine that is meant to have them.
 */
const NO_DUMP = (() => {
  try {
    execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'), 'build/parity_dump'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (error) {
    const said = `${error.stderr ?? ''}${error.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const why = said.find((l) => /error|not found|no such/i.test(l)) ?? said[0] ?? error.message;
    if (process.env.AMGI_REQUIRE_NATIVE === '1') throw new Error(`AMGI_REQUIRE_NATIVE=1, and the C dump tool did not build: ${why}`);
    return `the collection parity runner needs its C dump tool (server/Makefile: a C compiler, sqlite and ICU), which did not build on this machine (${why}), so it is skipped`;
  }
})();

for (const schema of ['18', '11']) {
  describe(`collection parity, schema ${schema}`, { skip: NO_DUMP ?? false }, () => {
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

    // Names that differ only by case, as Anki's unicase collation folds them (full case folding).
    // Here the C core and the frozen Node part on purpose: C finds the deck Anki would, Node
    // lower-cases and makes a second one (test/parity/C_DIFFS.txt names each line). Its own
    // session, so the main recordings stay the same for both.
    test('deck names that differ only by case, and what Anki makes of the result', async () => {
      const s = await session(schema, async (t) => {
        // Where both fold the same (toLowerCase does for these), first; the ones only unicase folds
        // last, so a deck one makes and the other does not shifts no number before it.
        for (const name of ['Äpfel', 'äPFEL', 'Öl::Ä', 'öl::ä', 'Straße', 'ﬃ']) await t.cmd(`createDeck ${enc(name)}`);
        const ids = await deckIds(t.impl);
        await t.cmd(`renameDeck ${ids['Äpfel']} ${enc('ÄPFEL::Öl')}`);
        await t.cmd(`createDeck ${enc('STRASSE')}`);
        await t.cmd(`createDeck ${enc('FFI')}`);
        await t.cmd(`renameDeck ${ids['Straße']} ${enc('strasse')}`);
        await t.cmd('listDecks');
      });
      check(`collection-${schema}-unicase-transcript`, s.transcript);
      check(`collection-${schema}-unicase-dump`, s.dump);
      if (anki) {
        const out = ankiCheck(s.copy.collection);
        // C's result is clean, and recorded (a C-only recording). Node's is not: its relaxed index
        // holds two names Anki calls equal, and Anki's repair renames either one, so only that
        // there is something to repair is checked.
        if (IMPL) check(`collection-${schema}-unicase-anki`, out);
        else assert.ok(/non-unique|_'|check database False/.test(out), `Anki finds Node's duplicate:\n${out}`);
      }
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

describe('collection parity: collections that cannot be opened', () => {
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
