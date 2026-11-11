'use strict';

// The bridge from this CLI to amgi's own card generator.
//
// Everything about how a clip is made - the Gemini model and voice pool, and
// the refusal to keep a clip that does not say what the card
// says - lives in ./cardGeneration/cardGeneration.ts, which is the same module
// amgi's own local generation path (server/amgi/gen.c, by way of
// generate-clip.js) and the Anki add-on's bridge run. A deck built here is
// therefore built to the standard the app already holds itself to, and there is
// only one place to improve when that standard moves.
//
// This module used to live beside a hosted edge function, the other runtime
// that needed it. That backend is retired (it is in git history); the policy
// moved here, into plusaudio's own
// package, because plusaudio/lib/generator.js and tests/server/plusaudio/generator.test.js
// are now its only importers.
//
// Requiring the TypeScript module directly (Node strips the types) is
// deliberate: no build step means no generated copy that can drift from its
// source, which is the failure this whole exercise exists to prevent.

const { generateCardAudio } = require('./cardGeneration/cardGeneration.ts');
const { createGeminiContext } = require('./geminiContext');

/**
 * Build a clip generator for augmentPackage and generate-clip.js.
 *
 * Every model call - speech, transcription, the judge - is Gemini's, through
 * the one context geminiContext.js builds from `options` (apiKey is
 * GEMINI_API_KEY). Without a key this throws at once, before any note is
 * attempted.
 *
 * @param {object} options  see geminiContext.js's createGeminiContext
 */
function createGenerator(options = {}) {
  const context = createGeminiContext(options);

  // `reading` is optional and empty by default: a deck this CLI did not
  // write carries no romanisation of its own text, so for Japanese and
  // Chinese the clip is validated by transcript alone and cardGeneration
  // says so in the log. A caller that just generated the text itself - see
  // the app's server, server/amgi/gen.c - has a spoken_reading
  // to pass here, and it goes to the audio judge, never to the synthesiser.
  // That reading is not stored anywhere else.
  //
  // Resolves to a WAV file's bytes, which every clip's *.wav name
  // (the add-on's deck_text.py and the server's web.c) relies on. geminiSpeech.ts is the one
  // place that is enforced: it wraps raw PCM and refuses anything else.
  return async function generate({ text, language, reading = '' }) {
    return Buffer.from(await generateCardAudio(context, { text, language, reading }));
  };
}

module.exports = { createGenerator };
