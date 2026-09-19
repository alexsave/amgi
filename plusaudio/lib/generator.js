'use strict';

// The bridge from this CLI to amgi's own card generator.
//
// Everything about how a clip is made - which voice, the per-language speaking
// instructions, and the refusal to keep a clip that does not say what the card
// says - lives in supabase/functions/_shared/cardGeneration.ts, which is the
// same module the web app's `cards` edge function runs. A deck built here is
// therefore built to the standard the app already holds itself to, and there is
// only one place to improve when that standard moves.
//
// Requiring the TypeScript module directly (Node strips the types) is
// deliberate: no build step means no generated copy that can drift from its
// source, which is the failure this whole exercise exists to prevent.

const { generateCardAudio } = require('../../supabase/functions/_shared/cardGeneration.ts');
const { CARD_MODELS } = require('../../supabase/functions/_shared/models.ts');

/**
 * Build a generator for augmentPackage.
 *
 * @param {object} openai      an OpenAI client
 * @param {object} [options]
 * @param {function} [options.log]  where the policy's own warnings go
 */
function createGenerator(openai, options = {}) {
  const { log = () => {} } = options;

  const context = {
    openai,
    models: CARD_MODELS,
    // Indented because these lines explain the note the CLI just announced.
    log: {
      warn: (message) => log(`  ${message}`),
      error: (message) => log(`  ${message}`),
    },
  };

  // No reading is passed: a deck this CLI did not write carries no
  // romanisation of its own text, so for Japanese and Chinese the clip is
  // validated by transcript alone and cardGeneration says so in the log. That
  // is the same gap the app has when it regenerates audio for a saved card.
  return async function generate({ text, language }) {
    return Buffer.from(await generateCardAudio(context, { text, language }));
  };
}

module.exports = { createGenerator };
