'use strict';

// The bridge from a CLI (or a server that shells out to one) to amgi's own
// card-text generator.
//
// Everything about how a card's text is written - one sense per card, the
// per-language register policy, speakable-only assembly, and the
// learning-language reading in its own script - lives in
// ./cardGeneration/cardGeneration.ts, the same module plusaudio/lib/generator.js
// already bridges for audio. This module is the text half of that same
// bridge, kept separate so a caller that only wants text (no audio field
// mapped yet) never pulls in an OpenAI client configured for speech.
//
// See generator.js's own comment for why this requires cardGeneration.ts
// directly rather than importing a built copy: no build step means no
// generated artifact that can drift from its source.

const { generateCardText } = require('./cardGeneration/cardGeneration.ts');
const { CARD_MODELS } = require('./cardGeneration/models.ts');

/**
 * Build a generator for a card's text.
 *
 * @param {object} openai      an OpenAI client
 * @param {object} [options]
 * @param {function} [options.log]  where the policy's own warnings go
 */
function createTextGenerator(openai, options = {}) {
  const { log = () => {} } = options;

  const context = {
    openai,
    models: CARD_MODELS,
    log: {
      warn: (message) => log(`  ${message}`),
      error: (message) => log(`  ${message}`),
    },
  };

  return async function generate(request) {
    return generateCardText(context, request);
  };
}

module.exports = { createTextGenerator };
