'use strict';

// The one place a Gemini API key becomes the context cardGeneration.ts runs
// in: the gRPC client (cardGeneration/gemini.ts), the speech synthesiser
// (cardGeneration/geminiSpeech.ts) and the model roster (models.ts).
// lib/generator.js builds its context here, so the CLI entry points and the
// Anki add-on (through generate-clip.js) generate with the same client and
// the same models (the app's server has its own C port, server/amgi/gemini.c).
//
// Requiring the TypeScript modules directly (Node strips the types) is
// deliberate: no build step means no generated copy that can drift from its
// source.

const { createGeminiClient } = require('./cardGeneration/gemini.ts');
const { MISSING_KEY_MESSAGE } = require('./geminiKey');
const { createGeminiSpeech } = require('./cardGeneration/geminiSpeech.ts');
const { CARD_MODELS, GEMINI_TTS_VOICES } = require('./cardGeneration/models.ts');
const { random: defaultRandom } = require('./random');
const { gateForThisProcess } = require('./ipcGate');

/**
 * Build the context cardGeneration.ts's generateCardText and
 * generateCardAudio take. Without a key this throws MISSING_KEY_MESSAGE -
 * from createGeminiClient, which owns that check.
 *
 * @param {object} options
 * @param {string} options.apiKey            GEMINI_API_KEY
 * @param {string} [options.baseUrl]         Gemini's gRPC endpoint; set only by tests and the e2e fake server
 *                                           (GEMINI_API_BASE, e.g. http://127.0.0.1:8799 for cleartext HTTP/2)
 * @param {object} [options.random]          the voice draw's source; ./random.js's process-wide generator by default
 * @param {function} [options.sleep]         how a per-minute rate limit is waited out
 * @param {function} [options.log]           where the policy's own warnings go
 * @param {object} [options.gate]            the rate gate every request passes; by default the
 *                                           parent server's over IPC when this process was forked
 *                                           with one, else this process's own (ipcGate.js)
 * @param {string} [options.ttsModel]        the speech model; models.ts's GEMINI_TTS_MODEL unless a dev
 *                                           script asks for another named one (build-starter-audio.js --model)
 */
function createGeminiContext({ apiKey, baseUrl, random = defaultRandom, sleep, log = () => {}, ttsModel = CARD_MODELS.tts, gate = gateForThisProcess() } = {}) {
  const gemini = createGeminiClient({
    apiKey,
    gate,
    ...(baseUrl ? { baseUrl } : {}),
    ...(sleep ? { sleep } : {}),
  });
  return {
    gemini,
    models: { ...CARD_MODELS, tts: ttsModel },
    speech: createGeminiSpeech({ client: gemini, model: ttsModel, voices: GEMINI_TTS_VOICES, random }),
    // Indented because these lines explain the note the CLI just announced.
    log: {
      warn: (message) => log(`  ${message}`),
      error: (message) => log(`  ${message}`),
    },
  };
}

/** The key and endpoint from the environment, the way every CLI entry point reads them. */
function geminiOptionsFromEnv(env = process.env) {
  return { apiKey: env.GEMINI_API_KEY || '', baseUrl: env.GEMINI_API_BASE || undefined };
}

module.exports = { MISSING_KEY_MESSAGE, createGeminiContext, geminiOptionsFromEnv };
