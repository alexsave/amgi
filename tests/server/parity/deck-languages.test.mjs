// What the server asks Gemini about a deck's languages, and what it does not ask: the requests themselves, which the HTTP recording
// (http.test.mjs) cannot show because its fake runs in another process. Each test reads the fake's own log of what reached it.
//   - a deck with a stored pair is never asked about;
//   - the one request for a deck with none: the cards' model, a strict schema (the 18 codes and none, high or low), the deck's name,
//     the note type and its field names, each field without its HTML and [sound:], cut to about 80 characters, at most ten notes;
//   - a card is made in the deck's pair, with the one text request it always made: no request more for the languages;
//   - a deck with no pair makes no card text request at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';
import { Impl } from './impl-process.mjs';
import { enc, noteTokens } from './protocol.mjs';
import { ROOT, startServer } from './servers.mjs';

const require = createRequire(import.meta.url);
const { fakeGemini } = require('../plusaudio/helpers/fake-gemini.js');

const stops = [];
after(async () => {
  for (const stop of stops) await stop();
});

/** A server on a fake Gemini that answers as `script` says, and a copy of the fixture collection it reads. */
async function rig(script) {
  const fake = await fakeGemini(script);
  const app = await startServer({ key: 'fake', base: fake.baseUrl });
  stops.push(app.stop, fake.close);
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-langs-'));
  const base = path.join(top, 'Anki2');
  fs.cpSync(path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18'), path.join(base, 'User 1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'addons21'), { recursive: true });
  const headers = {
    'x-amgi-base-dir': encodeURIComponent(base),
    'x-amgi-collection': encodeURIComponent(path.join(base, 'User 1', 'collection.anki2')),
    'x-amgi-profile': encodeURIComponent('User 1'),
  };
  async function ask(method, route, kind, answer, body) {
    const res = await fetch(new URL(`/api/anki/${route}`, app.url), {
      method,
      headers: { ...headers, ...(body ? { 'content-type': WIRE_MIME } : {}) },
      body: body ? encode(...body) : undefined,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body: decode(res.ok ? answer : 'error', bytes) };
  }
  const collection = path.join(base, 'User 1', 'collection.anki2');
  const decks = async () => Object.fromEntries((await ask('GET', 'decks', null, 'decks')).body.decks.map((d) => [d.name, d]));
  return { fake, ask, decks, collection };
}

const text = (request) => request.body.contents.flatMap((c) => c.parts).map((p) => p.text).join('\n');

test('a deck with a stored pair is never asked about', async () => {
  const r = await rig({ languages: { learning: 'ja', known: 'en', confidence: 'high' } });
  const deck = (await r.decks()).Existing.id;
  await r.ask('PUT', `decks/${deck}/languages`, null, 'deck_languages', ['q_deck_languages', { known: 'en', learning: 'ko' }]);
  const found = await r.ask('POST', `decks/${deck}/languages/detect`, null, 'deck_languages_found');
  assert.deepEqual([found.status, found.body.stored, found.body.known, found.body.learning, found.body.foundBy], [200, true, 'en', 'ko', 'stored']);
  assert.equal(r.fake.requests.length, 0, 'no request reached Gemini');
});

test('the request for a deck with no pair: the cards\' model, a strict schema, and the notes as the page would show them', async () => {
  const r = await rig({ languages: { learning: 'ko', known: 'en', confidence: 'high' } });
  const decks = await r.decks();
  const found = await r.ask('POST', `decks/${decks['Korean::문장'].id}/languages/detect`, null, 'deck_languages_found');
  assert.deepEqual([found.body.stored, found.body.known, found.body.learning, found.body.foundBy], [true, 'en', 'ko', 'gemini']);
  assert.equal(r.fake.requests.length, 1, 'one request');
  const [request] = r.fake.requests;
  assert.equal(request.kind, 'languages');
  assert.equal(request.model, 'gemini-3.8-flash', 'the model the cards\' text uses');
  const schema = request.body.generationConfig.responseJsonSchema;
  const codes = ['en', 'zh_cn', 'es', 'fr', 'pt', 'ru', 'id', 'de', 'ja', 'tr', 'zh_hk', 'vi', 'ko', 'it', 'th', 'hi', 'ur', 'ar', 'none'];
  assert.deepEqual(schema.properties.learning.enum, codes);
  assert.deepEqual(schema.properties.known.enum, codes);
  assert.deepEqual(schema.properties.confidence.enum, ['high', 'low']);
  assert.deepEqual(schema.required, ['learning', 'known', 'confidence']);
  assert.equal(schema.additionalProperties, false);
  assert.ok(request.body.generationConfig.thinkingConfig, 'thinking, as the card text asks');
  const prompt = text(request);
  assert.match(prompt, /^Deck name: Korean::문장\n/);
  assert.match(prompt, /note type "Basic"/);
  assert.match(prompt, /Front: /);
  const system = request.body.systemInstruction.parts.map((p) => p.text).join('');
  assert.match(system, /zh_cn \(Mandarin Chinese\)/);
  assert.match(system, /zh_cn is Mandarin Chinese in simplified characters; zh_hk is Cantonese/);
});

test('a card is made in the deck\'s pair with the one text request it always made, and Spanish pasted in is only the meaning', async () => {
  const card = { known_text: 'hello friend', learning_text: '你好朋友', sense_tag: '', register: 'polite', spoken_reading: 'ㄋㄧˇ ㄏㄠˇ ㄆㄥˊ ㄧㄡˇ' };
  const r = await rig({ text: card, transcribe: '你好朋友', judge: { heard: '你好朋友', matches: true, reason: 'the fake hears it' } });
  const deck = (await r.decks()).Existing.id;
  const noPair = await r.ask('POST', 'card-text', null, 'card_text', ['q_card_text', { userInput: 'hola amigo', deckId: deck }]);
  assert.equal(noPair.status, 409);
  assert.match(noPair.body.error, /^This deck has no languages yet: choose them first/);
  assert.equal(r.fake.requests.length, 0, 'a deck with no pair makes no request at all');
  await r.ask('PUT', `decks/${deck}/languages`, null, 'deck_languages', ['q_deck_languages', { known: 'en', learning: 'zh_cn' }]);
  const made = await r.ask('POST', 'card-text', null, 'card_text', ['q_card_text', { userInput: 'hola amigo', deckId: deck }]);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(r.fake.requests.length >= 1 && r.fake.of('text').length, 1, 'one text request for the card');
  const prompt = text(r.fake.of('text')[0]);
  assert.match(prompt, /The learner speaks English and is learning Mandarin Chinese/);
  assert.match(prompt, /If the input is in any other language, translate it into both\./);
  assert.doesNotMatch(prompt, /The input is written in English/);
  assert.equal(r.fake.of('languages').length, 0, 'no languages request for a card');
});

test('the sample is at most ten notes, each field cut and its HTML and sound references gone', async () => {
  const r = await rig({ languages: { learning: 'ko', known: 'en', confidence: 'low' } });
  const basic = (await r.ask('GET', 'notetypes', null, 'notetypes')).body.notetypes.find((n) => n.name === 'Basic');
  // A deck with notes and no pair, as collections have been: made through the collection core, which the routes' pair rule does not guard.
  const impl = new Impl();
  let deck;
  try {
    await impl.cmd(`open ${enc(r.collection)}`);
    deck = Number((await impl.cmd(`createDeck ${enc('Fourteen')}`)).split(' ')[1]);
    for (let i = 0; i < 14; i += 1) {
      const fields = [`<div><b>front</b>&nbsp;${i}</div>[sound:a${i}.mp3]`, `<br>${'가'.repeat(120)}`];
      assert.ok((await impl.cmd(`addNote ${noteTokens({ deckId: deck, notetypeId: basic.id, fields })}`)).startsWith('ok '));
    }
  } finally {
    await impl.close();
  }
  const found = await r.ask('POST', `decks/${deck}/languages/detect`, null, 'deck_languages_found');
  assert.deepEqual([found.status, found.body.stored, found.body.known, found.body.learning], [200, false, 'en', 'ko'], 'low confidence: only a guess');
  const prompt = text(r.fake.of('languages')[0]);
  assert.equal((prompt.match(/^Note \d+,/gm) || []).length, 10, 'ten notes of fourteen');
  assert.doesNotMatch(prompt, /[<>]|sound|mp3|&nbsp;/);
  assert.match(prompt, /Front: front 0\n/);
  assert.ok(prompt.includes(`Back: ${'가'.repeat(80)}...\n`), 'cut at 80 characters, said with an ellipsis');
  assert.ok(!prompt.includes('가'.repeat(81)));
});
