#!/usr/bin/env node
'use strict';

// Both sides of one card - or a rejected side rewritten - generated on
// demand for a caller that is not Node in-process.
//
// src/server/anki/cardText.js shells out to this file for the app's own
// add-note screen, the same boundary generate-clip.js already draws for
// audio: cardGeneration.ts is a plain TypeScript file with no build step,
// which has no place in the app's server bundle even with plusaudio a
// workspace package (see generate-clip.js's own module comment for the fuller
// version of this argument, and audio.js's for why the app's side of the
// boundary is a subprocess rather than an in-process require).
//
// CONTRACT
// --------
//
//   node generate-card-text.js --known <lang> --learning <lang>
//       [--input <text>]
//       [--current-front <text> --current-back <text> --current-reading <text>]
//       [--regenerate <front_text,back_text>]
//
//   --known / --learning  amgi language codes (ko, ja, zh_cn, es, ...). Required.
//                         --known is the front of the card, --learning the back.
//   --input               what the learner typed. Required unless a card is being
//                         regenerated (--current-front or --current-back given).
//   --current-front       the known side of the card being rewritten.
//   --current-back        the learning side of the card being rewritten.
//   --current-reading     that card's own spoken_reading, if it has one - kept
//                         across a regeneration that does not touch the learning
//                         side, dropped otherwise (see cardGeneration.ts's own
//                         handling of this in generateCardText).
//   --regenerate          which side(s) the learner rejected, comma-separated:
//                         "front_text", "back_text", or both. Omit for a fresh
//                         card generated from --input alone.
//
//   stdout, on success: one line of JSON - {"front_text":...,"back_text":...,"spoken_reading":...}
//   stderr: usage text, the failure message, and cardGeneration.ts's own warnings
//           (a corrective retry, a model that kept breaking the speakable rule).
//   exit 0: success. exit 1: could not generate a card - OPENAI_API_KEY is not
//           set, or a network/API error. exit 2: usage error.
//
// No --audio-out here: text and audio are two different calls
// (src/server/anki/cardText.js makes both, passing this file's own
// spoken_reading straight into the second one) so that a caller who only
// wants to see the text before committing to a clip never pays for one.

const path = require('node:path');
const { createTextGenerator } = require('./lib/textGenerator');

const USAGE =
  'Usage: node generate-card-text.js --known <lang> --learning <lang> ' +
  '[--input <text>] [--current-front <text> --current-back <text> --current-reading <text>] ' +
  '[--regenerate front_text,back_text]\n';

const FLAGS_WITH_VALUES = new Set([
  '--known',
  '--learning',
  '--input',
  '--current-front',
  '--current-back',
  '--current-reading',
  '--regenerate',
]);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(arg)) {
      throw new Error(`unknown option ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${arg} needs a value`);
    }
    options[arg.slice(2)] = value;
    i += 1;
  }
  return options;
}

/**
 * Runs the already-parsed, already-validated request and prints its result.
 * Split out from `main` so tests can drive it with a stubbed `generate`
 * function and never construct a real OpenAI client or touch the network.
 *
 * @returns {Promise<number>} the process exit code.
 */
async function run(options, generate) {
  const hasCurrent = options['current-front'] !== undefined || options['current-back'] !== undefined;
  const currentCard = hasCurrent
    ? {
        front_text: options['current-front'] || '',
        back_text: options['current-back'] || '',
        spoken_reading: options['current-reading'] || '',
      }
    : null;
  const regenerateParts = options.regenerate
    ? options.regenerate.split(',').map((part) => part.trim()).filter(Boolean)
    : [];

  let card;
  try {
    card = await generate({
      userInput: options.input || '',
      knownLanguage: options.known,
      learningLanguage: options.learning,
      currentCard,
      regenerateParts,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(card)}\n`);
  return 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const missing = ['known', 'learning'].filter((key) => !options[key]);
  if (missing.length > 0) {
    process.stderr.write(`missing required option(s): ${missing.join(', ').replace(/(^|, )/g, '$1--')}\n${USAGE}`);
    return 2;
  }
  const hasCurrent = options['current-front'] !== undefined || options['current-back'] !== undefined;
  if (!options.input && !hasCurrent) {
    process.stderr.write(`--input is required unless regenerating an existing card\n${USAGE}`);
    return 2;
  }

  // Same lookup generate-clip.js already uses: an environment variable wins,
  // and a .env file next to this script (never committed - see .gitignore)
  // is the fallback for a plain checkout with nothing else setting it.
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch {
    // No .env next to this script; the environment is expected to carry the key.
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    process.stderr.write('OPENAI_API_KEY is not set (checked the environment and plusaudio/.env).\n');
    return 1;
  }

  const OpenAI = require('openai');
  const generate = createTextGenerator(new OpenAI({ apiKey }), {
    log: (line) => process.stderr.write(`${line}\n`),
  });

  return run(options, generate);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, run };
