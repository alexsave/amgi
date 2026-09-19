#!/usr/bin/env node
'use strict';

// One clip, generated on demand, for a caller that is not Node.
//
// anki/addon/amgi_audio/generator.py's NodeCliAudioGenerator shells out to this file to
// fill audio into a live Anki collection without a second copy of the generation policy
// in Python (see lib/generator.js's own comment for why: one policy, cardGeneration.ts,
// called from Node - that rule is not up for grabs here). This file is therefore a
// supported boundary between two languages and its contract is part of the add-on's
// interface, not an implementation detail either side can change alone. Any change here
// needs a matching change on the Python side (generator.py) and its tests.
//
// CONTRACT
// --------
//
//   node generate-clip.js --text <string> --language <code> --out <path>
//
//   --text      the exact text to speak. Required. Spoken as-is, with no HTML stripping
//               or tag removal here: a caller with its own field markup (the add-on's
//               deck_text.spoken_text, add-audio.js's own note-field handling) has
//               already reduced it to plain spoken text before this is called.
//   --language  an amgi language code (ko, ja, zh_cn, es, ...). Required. Picks the
//               speaking instructions and the language the validator transcribes in, the
//               same as everywhere else this generator is called from.
//   --out       filesystem path to write the generated clip's bytes to. Required. The
//               parent directory must already exist. Written only on success; a failed
//               run leaves no file at this path, and removes one left over from an
//               earlier attempt at the same path, so a caller can tell success from
//               failure by the file's mere existence afterwards.
//
// No `--reading`: like lib/generator.js's existing adapter (see its own comment), this
// entry point never has one to pass, because a caller reaching for a subprocess has a
// field's saved text and nothing else - no romanisation of its own. Adding one later is
// additive (a caller not passing it keeps working); this file does not need to guess at
// that shape today.
//
//   stdout: nothing on success today. Reserved for future machine-readable output; a
//           caller must not rely on stdout staying empty forever, only on it never
//           carrying anything needed to interpret the exit code or the file at --out.
//   stderr: human-readable text only. Usage text on a bad invocation, the failure
//           message on a non-zero exit, and any non-fatal warning cardGeneration.ts's
//           injected logger emits along the way (a missing reading for a language whose
//           script hides one, a validator falling back after the audio judge is
//           unreachable). A caller that only checks the exit code is still correct:
//           stderr here is for a human reading a log, not for a parser.
//   exit 0: success. --out was written.
//   exit 1: could not produce audio - OPENAI_API_KEY is not set, a network/API error, or
//           cardGeneration.ts's own validation gave up after its retries. --out was not
//           written.
//   exit 2: usage error - a missing, unknown or valueless argument. Nothing was
//           attempted; --out, if it already existed, is untouched.
//
// This file is argument handling and file I/O only. It has no generation policy of its
// own: it hands text and language straight to lib/generator.js's createGenerator, the
// same adapter add-audio.js already uses over cardGeneration.ts.

const fs = require('node:fs');
const path = require('node:path');
const { createGenerator } = require('./lib/generator');

const USAGE = 'Usage: node generate-clip.js --text <text> --language <code> --out <path>\n';

const FLAGS_WITH_VALUES = new Set(['--text', '--language', '--out']);

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

/** Removes a stale clip at `outPath` from an earlier run, if there is one. */
function removeStaleOutput(outPath) {
  try {
    fs.unlinkSync(outPath);
  } catch {
    // Nothing there to remove - the common case.
  }
}

/**
 * Runs the already-parsed, already-validated request: generate one clip and write it to
 * `options.out`. Split out from `main` so tests can drive it with a stubbed `generate`
 * function and never construct a real OpenAI client or touch the network.
 *
 * @returns {Promise<number>} the process exit code.
 */
async function run(options, generate) {
  let audio;
  try {
    audio = await generate({ text: options.text, language: options.language });
  } catch (error) {
    removeStaleOutput(options.out);
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  fs.writeFileSync(options.out, audio);
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
  const missing = ['text', 'language', 'out'].filter((key) => !options[key]);
  if (missing.length > 0) {
    process.stderr.write(`missing required option(s): ${missing.join(', ').replace(/(^|, )/g, '$1--')}\n${USAGE}`);
    return 2;
  }

  // Same lookup add-audio.js already uses: an environment variable wins, and a .env file
  // next to this script (never committed - see .gitignore) is the fallback for a plain
  // Anki install with nothing else setting the environment.
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
  const generate = createGenerator(new OpenAI({ apiKey }), {
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
