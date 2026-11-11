'use strict';

// The voice pool (models.ts's GEMINI_TTS_VOICES) and how a clip's voice is
// drawn from it. Variety is the point - a learner hears many speakers - so
// every clip draws at random, and a retry never repeats the voice that just
// failed. The pool holds only voices that passed a survey (see models.ts):
// each read three phrases (ja, ko, ru) that the pipeline's own transcription
// check then accepted.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { GEMINI_TTS_VOICES } = require('../../../plusaudio/lib/cardGeneration/models.ts');
const { createGeminiSpeech } = require('../../../plusaudio/lib/cardGeneration/geminiSpeech.ts');
const { createRandom } = require('../../../plusaudio/lib/random');

// Gemini's prebuilt TTS voices, as its speech-generation docs list them
// (https://aistudio.google.com/docs/speech-generation, 2026-11-08).
const DOCUMENTED_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

const speechWith = (seed) => createGeminiSpeech({ client: { generateContent: async () => ({}) }, model: 'm', voices: GEMINI_TTS_VOICES, random: createRandom(seed) });

test('every voice in the pool is a documented Gemini voice, listed once', () => {
  for (const voice of GEMINI_TTS_VOICES) assert.ok(DOCUMENTED_VOICES.includes(voice), `${voice} is not a Gemini prebuilt voice`);
  assert.equal(new Set(GEMINI_TTS_VOICES).size, GEMINI_TTS_VOICES.length, 'no voice twice, or it would be drawn twice as often');
});

test('the pool is wide: variety is the point, and a retry needs another voice to go to', () => {
  assert.ok(GEMINI_TTS_VOICES.length >= 20, `only ${GEMINI_TTS_VOICES.length} voices`);
});

test('drawing clip after clip reaches every voice in the pool, never the same one twice in a row', () => {
  const speech = speechWith(99);
  const seen = new Set();
  let previous = null;
  for (let i = 0; i < 2000; i += 1) {
    const voice = speech.pickVoice(previous);
    assert.notEqual(voice, previous);
    seen.add(voice);
    previous = voice;
  }
  assert.deepEqual([...seen].sort(), [...GEMINI_TTS_VOICES].sort());
});

test('the same seed draws the same voices from the pool', () => {
  const draws = (seed) => {
    const speech = speechWith(seed);
    let previous = null;
    return Array.from({ length: 50 }, () => (previous = speech.pickVoice(previous)));
  };
  assert.deepEqual(draws(2026), draws(2026));
  assert.notDeepEqual(draws(2026), draws(2027));
});
