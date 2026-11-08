// The collection core's rules, C against the JavaScript they replace: every text, JSON, path and
// number rule the C port reimplements (server/collection), run over one generated corpus by both
// (server/test/difftest.c for the C), every answer compared. Where the collection runner checks
// whole operations, this reaches the corners: markup that only nearly is a media tag, entities that
// name surrogates or nothing, every kind of space JavaScript trims, case and normalisation tables,
// JSON key order and number formats, Node's path rules.
//
// The corpus comes from plusaudio/lib/random.js's generator at a fixed seed, so it is the same on
// every run; DIFFTEST_CASES raises how many cases each rule gets.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { looksRomanized } from '../../plusaudio/lib/cardGeneration/cardText.ts';

const require = createRequire(import.meta.url);
const { ankiFields, fieldChecksum, renderAudioReference, stripHtmlPreservingMedia } = require('../../plusaudio/lib/deck.js');
const { normalizeComponent } = require('../../plusaudio/lib/collection/decks.js');
const { ordinalsForNewNote, templateRendersNonEmpty } = require('../../plusaudio/lib/collection/template.js');
const { createRandom } = require('../../plusaudio/lib/random.js');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BIN = path.join(ROOT, 'server', 'build', 'difftest');
const CASES = Number(process.env.DIFFTEST_CASES || 1500);

const PIECES = [
  '<', '>', '<img', '<IMG ', '<audio', '<Audio\t', '<object', '<imgx', ' src', 'SRC', ' data', 'xsrc', '=', ' = ', '"', "'",
  'a.png', 'b c', 'x', '&', '&amp;', '&AMP;', '&lt;', '&nbsp;', '&quot;', '&apos;', '&bogus;', '&#65;', '&#x41;', '&#X41;',
  '&#x1F600;', '&#xD83D;', '&#xDE00;', '&#0;', '&#1114112;', '&#99999999999999999999;', '&#x;', '&#12a;', '&#', ';',
  '<!--', '-->', '<!-->', ' ', '  ', '\t', '\n', '\r', ' ', '　', ' ', '﻿', '\u0085', '​', ' ',
  'é', 'é', 'É', 'Σ', 'ς', 'ΣΑΣ', 'ß', 'İ', 'ı', 'K', 'Ǆ', 'ﬃ', '한', '가', 'ㄱ', '漢', 'あ', 'ア', 'й', 'ب',
  'क', 'ก', 'abc', 'Hello', '🙂', '\u{1F600}', '\x1f', '\x00', '\x01', '\x7f', '\x1b', ':', '::', '{{', '}}', '{{Front}}',
  '{{#Back}}', '{{/Back}}', '{{^Back}}', '{{c1::', '{{c3::', '{{c0::', '{{c600::', '{{c12', '::hint}}', '{{text:Front}}',
  '<img xsrc="q.png">', '<img alt=1 src=r.png>', '<audio xdata=v src="s.wav">', '<object data-x=1 data=t.swf>', ' xsrc=u ',
  '&#x10FFFF;', '&#1114111;', '&#x110000;', '\uff01', '\ue000', '\ufffd',
];
// One character from each side of UTF-16's surrogate range, for string comparison.
const ORDER = ['a', '\ud7ff', '\ue000', '\uff01', '\uffff', '\u{10000}', '\u{1F600}', '\u{10FFFF}', 'é', ''];
const LANGS = ['ko', 'ja', 'zh_cn', 'zh-HK', 'ZH_CN', ' ru ', 'ar', 'ur', 'hi', 'th', 'en', 'es', '', 'xx'];

const random = createRandom(20261108);
const pick = (list) => list[random.int(list.length)];
function text(max = 8) {
  let s = '';
  for (let i = random.int(max + 1); i > 0; i -= 1) s += pick(PIECES);
  return s;
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const unhexed = (h) => Buffer.from(h, 'hex').toString('utf8');

/** Each case: the op, its arguments, and what the JavaScript answers (a string, or a thrown message). */
const RULES = {
  lower: () => { const s = text(); return [[s], () => s.toLowerCase()]; },
  nfc: () => { const s = text(); return [[s], () => s.normalize('NFC')]; },
  trim: () => { const s = text(4); return [[s], () => s.trim()]; },
  // (No "fold": C folds deck names as unicase does, full case folding, where foldKey lower-cases;
  // a fix, not parity. server/test/unit.c holds it to Anki's answers.)
  strip: () => { const s = text(12); return [[s], () => stripHtmlPreservingMedia(s)]; },
  csum: () => { const s = text(10); return [[s], () => String(fieldChecksum(s))]; },
  ankifield: () => { const s = text(); return [[s], () => ankiFields([s])[0]]; },
  roman: () => { const s = text(4); const l = pick(LANGS); return [[s, l], () => (looksRomanized(s, l) ? '1' : '0')]; },
  audio: () => { const s = text(4); return [[s], () => renderAudioReference(s, 'html')]; },
  components: () => { const s = text(); return [[s], () => s.split('::').map(normalizeComponent).join('\x1e')]; },
  num: () => {
    const forms = [() => String(random.int(1 << 30) * 4096 + random.int(4096)), () => `${random.int(1000)}.${random.int(1000)}`,
      () => `${random.int(10)}e${random.int(60) - 30}`, () => `-${random.int(100000)}.5`, () => `1e${random.int(30)}`,
      () => `0.${'0'.repeat(random.int(9))}${random.int(99) + 1}`, () => `${random.int(2 ** 31)}${random.int(2 ** 31)}`];
    const s = pick(forms)();
    return [[s], () => String(Number(s))];
  },
  json: () => {
    const keys = ['1', '0', '01', '10', '4294967294', '4294967295', '1794169279580', 'a', 'name', '__proto__', '-1', '1.5', 'é'];
    const values = ['1', '1.50', '-0', '1e21', '1E-7', '123456789012345680000', '0.1', 'true', 'null', '"x"', '"\\u00e9\\n\\t\\"\\\\\\/"',
      '"\\ud83d\\ude00"', '"\\ud800"', '"\\u001f\\u007f"', '[1,[2,{}]]', '{"b":1,"a":2}', '"é"'];
    const n = random.int(6);
    const parts = [];
    for (let i = 0; i < n; i += 1) parts.push(`${pick(['', ' ', '\n'])}"${pick(keys)}"${pick(['', ' '])}:${pick(values)}`);
    const s = random.int(20) === 0 ? `{${parts.join(',')}` : `{${parts.join(',')}}`;
    return [[s], () => { try { return JSON.stringify(JSON.parse(s)); } catch { throw new Error('SyntaxError'); } }];
  },
  cmp: () => {
    const a = random.int(2) ? text(3) : pick(ORDER) + pick(ORDER);
    const b = random.int(2) ? text(3) : pick(ORDER) + pick(ORDER);
    return [[a, b], () => String(a < b ? -1 : a > b ? 1 : 0)];
  },
  locale: () => { const a = text(3); const b = text(3); return [[a, b], () => String(Math.sign(a.localeCompare(b)))]; },
  extname: () => {
    const s = pick(['a.b', '.a', 'a.', 'a.b.c', '..', '.', 'a/b.c', 'a.b/', 'a/.b', '..a', 'a..', '/x/y.z.', 'noext', '']) + pick(['', '.wav', 'x']);
    return [[s], () => path.extname(s)];
  },
  basename: () => { const s = pick(['../escape.wav', 'dir/sub.wav', '/a/b/', 'a//', '..', '.', '', 'x', '//']); return [[s], () => path.basename(s)]; },
  join: () => {
    const d = pick(['/m', '/m/', '/a/b', 'rel']);
    const n = pick(['x', '../x', '..', '', '.', 'a/../../b', './y', '/abs', 'x/', '../../../../z']);
    return [[d, n], () => path.join(d, n)];
  },
  renders: () => {
    const t = text(6);
    const names = ['Front', 'Back', 'text:Front', 'Card'].filter(() => random.int(2));
    return [[t, names.join('\x1e')], () => (templateRendersNonEmpty(t, new Set(names)) ? '1' : '0')];
  },
  cloze: () => {
    const fields = [text(6), text(6)];
    return [fields, () => ordinalsForNewNote({ kind: 'cloze', templates: [], fieldNames: [], fieldValues: fields, tags: [] }).join(',')];
  },
  rng: () => {
    const seed = random.uint32();
    return [[String(seed)], () => { const r = createRandom(seed); return Array.from({ length: 8 }, () => r.uint32()).join(','); }];
  },
};

before(() => {
  execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'), 'build/difftest'], { stdio: 'inherit' });
});

for (const [op, make] of Object.entries(RULES)) {
  test(`C answers as the JavaScript: ${op}`, () => {
    const cases = Array.from({ length: op === 'rng' ? 50 : CASES }, () => make());
    const input = cases.map(([args]) => [op, ...args.map(hex)].join(' ')).join('\n');
    const out = execFileSync(BIN, { input: `${input}\n`, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n');
    let failures = 0;
    const shown = [];
    cases.forEach(([args, js], i) => {
      let want;
      try {
        want = hex(js());
      } catch (error) {
        want = `!${hex(error.message)}`;
      }
      if (out[i] !== want) {
        failures += 1;
        if (shown.length < 5) {
          const got = out[i]?.startsWith('!') ? `throws ${unhexed(out[i].slice(1))}` : JSON.stringify(unhexed(out[i] ?? ''));
          const exp = want.startsWith('!') ? `throws ${unhexed(want.slice(1))}` : JSON.stringify(unhexed(want));
          shown.push(`  ${op}(${args.map((a) => JSON.stringify(a)).join(', ')})\n    JavaScript: ${exp}\n    C:          ${got}`);
        }
      }
    });
    assert.equal(failures, 0, `${failures} of ${cases.length} differ:\n${shown.join('\n')}`);
  });
}
