'use strict';

// The bridge from this CLI to amgi's own card generator.
//
// Everything about how a clip is made - the Gemini model and voice pool, and
// the refusal to keep a clip that does not say what the card
// says - lives in ./cardGeneration/cardGeneration.ts, which is the same module
// amgi's own local generation path (src/server/anki/audio.js, by way of
// generate-clip.js) and the Anki add-on's bridge run. A deck built here is
// therefore built to the standard the app already holds itself to, and there is
// only one place to improve when that standard moves.
//
// This module used to live in supabase/functions/_shared/, back when a hosted
// edge function was the other runtime that needed it. That backend is retired
// (see archives/supabase-2026/); the policy moved here, into plusaudio's own
// package, because plusaudio/lib/generator.js and plusaudio/test/generator.test.js
// are now its only importers.
//
// Requiring the TypeScript module directly (Node strips the types) is
// deliberate: no build step means no generated copy that can drift from its
// source, which is the failure this whole exercise exists to prevent.

const { generateCardAudio } = require('./cardGeneration/cardGeneration.ts');
const { createGeminiSpeech } = require('./cardGeneration/geminiSpeech.ts');
const { CARD_MODELS, GEMINI_TTS_VOICES } = require('./cardGeneration/models.ts');
const { random: defaultRandom } = require('./random');

/**
 * Build a generator for augmentPackage.
 *
 * Speech is Gemini's and nothing else's, so `geminiApiKey` is required: a
 * generator built without one fails every clip with "GEMINI_API_KEY is not
 * set" (the OpenAI client is still needed for transcription and the judge).
 *
 * @param {object} openai      an OpenAI client
 * @param {object} [options]
 * @param {string} [options.geminiApiKey]
 * @param {string} [options.geminiApiBase]  Gemini's endpoint; set only by tests and the e2e fake server (GEMINI_API_BASE)
 * @param {function} [options.fetch]        what the Gemini client calls; global fetch by default
 * @param {object} [options.random]         the voice draw's source; ./random.js's process-wide generator by default
 * @param {function} [options.sleep]        how a per-minute rate limit is waited out
 * @param {function} [options.log]          where the policy's own warnings go
 */
function createGenerator(openai, options = {}) {
  const { log = () => {}, geminiApiKey = '', geminiApiBase, fetch, random = defaultRandom, sleep } = options;

  const speech = geminiApiKey
    ? createGeminiSpeech({
        apiKey: geminiApiKey,
        model: CARD_MODELS.tts,
        voices: GEMINI_TTS_VOICES,
        random,
        ...(geminiApiBase ? { baseUrl: geminiApiBase } : {}),
        ...(fetch ? { fetch } : {}),
        ...(sleep ? { sleep } : {}),
      })
    : null;

  const context = {
    openai,
    models: CARD_MODELS,
    speech,
    // Indented because these lines explain the note the CLI just announced.
    log: {
      warn: (message) => log(`  ${message}`),
      error: (message) => log(`  ${message}`),
    },
  };

  // `reading` is optional and empty by default: a deck this CLI did not
  // write carries no romanisation of its own text, so for Japanese and
  // Chinese the clip is validated by transcript alone and cardGeneration
  // says so in the log. A caller that just generated the text itself - see
  // textGenerator.js and src/server/anki/cardText.js - has a spoken_reading
  // to pass here, and it goes to the audio judge, never to the synthesiser.
  // That reading is not stored anywhere else.
  //
  // Resolves to a WAV file's bytes, which every clip's *.wav name
  // (audio-store.js's CLIP_EXTENSION) relies on. geminiSpeech.ts is the one
  // place that is enforced: it wraps raw PCM and refuses anything else.
  return async function generate({ text, language, reading = '' }) {
    if (!speech) throw new Error('GEMINI_API_KEY is not set; audio was not generated.');
    return Buffer.from(await generateCardAudio(context, { text, language, reading }));
  };
}

module.exports = { createGenerator };
