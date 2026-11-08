// The card text policy and the prompts in C (server/amgi/cards.c) against the TypeScript they port
// (plusaudio/lib/cardGeneration/cardText.ts, cardPrompts.ts, cardGeneration.ts's schemas and
// src/server/anki/sideOrder.js), answer for answer, over one corpus: every string literal of the
// TypeScript's own tests (plusaudio/test/cardText.test.js and koreanPronunciation.test.js), every
// language code amgi names and a few it does not, and a seeded run of strings built from the
// characters the rules turn on. The prompts are compared whole, for every language pair, in all
// three directions; the schemas as the protobuf Value bytes each side sends.
//
// Comparison scaffolding: removed at L4 with the TypeScript (and server/test/cards_dump.c with it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import * as T from '../../plusaudio/lib/cardGeneration/cardText.ts';
import * as P from '../../plusaudio/lib/cardGeneration/cardPrompts.ts';
import * as G from '../../plusaudio/lib/cardGeneration/cardGeneration.ts';
import * as W from '../../plusaudio/lib/cardGeneration/geminiWire.ts';
import { correctSwappedSides, detectInputLanguage } from '../../src/server/anki/sideOrder.js';
import { createRandom } from '../../plusaudio/lib/random.js';
import { ROOT } from './servers.mjs';

const DUMP = path.join(ROOT, 'server', 'build', 'cards_dump');
const US = '\x1f';
const esc = (s) => String(s).replace(/\n/g, '\x1e');

let child;
let lines;
before(() => {
  execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'), 'build/cards_dump'], { stdio: 'inherit' });
  child = spawn(DUMP, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
});
after(() => child?.kill());

async function c(...fields) {
  child.stdin.write(`${fields.map(esc).join(US)}\n`);
  const { value } = await lines.next();
  return value.replace(/\x1e/g, '\n');
}

const literals = (file) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)]
    .map((m) => (m[1] ?? m[2]).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'));
};
const CODES = [...Object.keys(T.LANGUAGE_NAMES), 'xx', 'ZH-hk', ' Ko ', 'ja_JP', ''];
const ALPHABET = [...'ab Z1 2.,;:!?/|｜()（）[]［］-*•"\'“”„«»『』「」、。！？，；：\t\n 가각갂값닭읽없앉많좋싫학국종신설예이히ㅎ漢字かなカナ привет مرحبا नमस्ते สวัสดี'];
function corpus() {
  const r = createRandom(20261108);
  const random = Array.from({ length: 600 }, () => {
    const n = 1 + r.int(14);
    return Array.from({ length: n }, () => ALPHABET[r.int(ALPHABET.length)]).join('');
  });
  return [...new Set([...literals('plusaudio/test/cardText.test.js'), ...literals('plusaudio/test/koreanPronunciation.test.js'), ...random])];
}

test('the text rules answer as cardText.ts does', async () => {
  const texts = corpus();
  let compared = 0;
  for (const t of texts) {
    assert.equal(await c('spokenForm', t), T.spokenForm(t), `spokenForm(${JSON.stringify(t)})`);
    assert.equal(await c('speakableUtterance', t), T.speakableUtterance(t), `speakableUtterance(${JSON.stringify(t)})`);
    assert.equal(await c('unspeakableReason', t), T.unspeakableReason(t) ?? '', `unspeakableReason(${JSON.stringify(t)})`);
    assert.equal(await c('koreanPronunciation', t), T.koreanPronunciation(t), `koreanPronunciation(${JSON.stringify(t)})`);
    for (const lang of ['ko', 'ja', 'en', 'zh_cn', 'ru', 'ar', 'hi', 'th', 'ko-KR']) {
      assert.equal(await c('normalizeForComparison', t, lang), T.normalizeForComparison(t, lang), `normalizeForComparison(${JSON.stringify(t)}, ${lang})`);
      assert.equal(await c('hasNativeScript', t, lang), T.hasNativeScript(t, lang) ? '1' : '0', `hasNativeScript(${JSON.stringify(t)}, ${lang})`);
      compared += 2;
    }
    for (const [known, learning] of [['en', 'ko'], ['en', 'ja'], ['ko', 'en'], ['es', 'fr'], ['ru', 'zh_cn']]) {
      assert.equal(await c('detectInputLanguage', t, known, learning), detectInputLanguage(t, known, learning) ?? '', `detectInputLanguage(${JSON.stringify(t)}, ${known}, ${learning})`);
      const s = correctSwappedSides({ front_text: t, back_text: 'x 안녕', spoken_reading: 'r' }, learning);
      assert.equal(await c('correctSwappedSides', t, 'x 안녕', 'r', learning), `${s.front_text}\x1d${s.back_text}\x1d${s.spoken_reading}`);
      compared += 2;
    }
    compared += 4;
  }
  const tags = ['', ' (calendar day) ', 'casual', 'Casual', '（礼貌）', 'calendar day'];
  for (const t of texts.slice(0, 200)) {
    for (const tag of tags) {
      for (const tag2 of ['', 'casual', 'formal']) {
        assert.equal(await c('composeKnownSide', t, tag, tag2), T.composeKnownSide(t, [tag, tag2 || null]), `composeKnownSide(${JSON.stringify(t)}, ${tag}, ${tag2})`);
        compared += 1;
      }
    }
  }
  for (const lang of CODES) {
    assert.equal(await c('languageName', lang), T.languageName(lang), `languageName(${lang})`);
    for (const level of ['casual', ' POLITE ', 'formal', 'rude', '']) {
      assert.equal(await c('registerTag', lang, level), T.registerTag(lang, level) ?? '', `registerTag(${lang}, ${level})`);
    }
  }
  assert.ok(compared > 20000, `compared ${compared}`);
});

test('the generation prompt, for every pair and direction, and the corrective retry, as cardPrompts.ts writes them', async () => {
  for (const known of CODES) {
    for (const learning of CODES) {
      for (const inputLanguage of [undefined, 'known', 'learning']) {
        const want = P.buildCardGenerationPrompt({ userInput: 'line "7"', knownLanguage: known, learningLanguage: learning, inputLanguage });
        assert.equal(await c('prompt', 'line "7"', known, learning, inputLanguage ?? ''), want, `prompt ${known} -> ${learning}, ${inputLanguage}`);
      }
    }
  }
  const reasons = ['it is empty', 'it offers alternatives separated by a slash'];
  for (const reason of reasons) {
    assert.equal(await c('retryPrompt', 'previous\nprompt', '날짜 / 데이트', reason), P.buildUnspeakableRetryPrompt('previous\nprompt', '날짜 / 데이트', reason));
  }
});

test('the response schemas, as the bytes geminiWire.ts sends', async () => {
  const hex = (b) => Buffer.from(b).toString('hex');
  assert.equal(await c('schema', 'generated'), hex(W.encodeValue(G.GENERATED_CARD_FORMAT.schema)));
  // The verdict and match formats are not exported; their shape as cardGeneration.ts declares it.
  const format = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' });
  assert.equal(await c('schema', 'verdict'), hex(W.encodeValue(format({
    heard: { type: 'string', description: 'What the audio actually says, as heard' },
    matches: { type: 'boolean', description: 'True if the audio says exactly the expected phrase in the expected language with intelligible pronunciation' },
    reason: { type: 'string', description: 'Brief justification for the verdict' },
  }))));
  assert.equal(await c('schema', 'match'), hex(W.encodeValue(format({ matches: { type: 'boolean' } }))));
});
