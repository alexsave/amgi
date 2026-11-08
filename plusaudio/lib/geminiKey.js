'use strict';

// What a person is told about the one API key amgi needs. Plain JavaScript so
// both sides can import it: plusaudio's TypeScript policy
// (cardGeneration/gemini.ts) and the app's server (src/server/anki/audio.js,
// cardText.js), which cannot load TypeScript.

const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';

const MISSING_KEY_MESSAGE =
  `GEMINI_API_KEY is not set, so nothing was generated: get a key at ${GEMINI_KEY_PAGE}, add it to .env.local and restart amgi.`;

module.exports = { GEMINI_KEY_PAGE, MISSING_KEY_MESSAGE };
