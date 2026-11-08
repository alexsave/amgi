#!/usr/bin/env node
'use strict';

// One clip, generated on demand, for a caller that is not Node.
//
// anki/addon/amgi_bridge/generator.py's NodeCliAudioGenerator shells out to this file to
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
//   node generate-clip.js --text <string> --language <code> --out <path> [--reading <text>]
//
//   --text      the exact text to speak. Required. Spoken as-is, with no HTML stripping
//               or tag removal here: a caller with its own field markup (the add-on's
//               deck_text.spoken_text, add-audio.js's own note-field handling) has
//               already reduced it to plain spoken text before this is called.
//   --language  an amgi language code (ko, ja, zh_cn, es, ...). Required. Picks the
//               language the validator transcribes and judges in, the same as everywhere
//               else this generator is called from.
//   --out       filesystem path to write the generated clip to - always a WAV file (Gemini
//               TTS, 24 kHz mono 16-bit, about 48 KB per second), so name it *.wav. The
//               parent directory must already exist. Written only on success; a failed
//               run leaves no file at this path, and removes one left over from an
//               earlier attempt at the same path, so a caller can tell success from
//               failure by the file's mere existence afterwards.
//   --reading   how --text must be read aloud, in its own script (kana, zhuyin) - only
//               meaningful for the languages cardText.ts's READING_OPAQUE_LANGUAGES
//               lists. Optional: a caller reaching for a subprocess with a saved field's
//               text and nothing else has no romanisation of its own to pass, and
//               omitting this keeps that path working exactly as before. Passed straight
//               through to generateCardAudio, which is the only place a reading is
//               allowed to inform validation - the audio judge listens for it; it is never
//               sent to the synthesiser, which would read it aloud (see src/server/anki/cardText.js
//               for the one caller that actually has one, and why it must be passed in
//               the same call that produced it rather than a later one).
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
//   exit 1: could not produce audio - GEMINI_API_KEY is not set, a network/API error, the day's
//           Gemini quota is spent, or cardGeneration.ts's own validation gave up after its
//           retries. The last stderr line is a one-line message meant to be shown to the
//           person as-is. --out was not written.
//
// ENVIRONMENT: GEMINI_API_KEY, from the environment or plusaudio/.env - the one key every
// call (speech, transcription, the audio judge) uses.
// GEMINI_API_BASE overrides Gemini's endpoint; it exists for tests and the e2e fake server.
//   exit 2: usage error - a missing, unknown or valueless argument. Nothing was
//           attempted; --out, if it already existed, is untouched.
//   exit 3: rate limited - Gemini's per-minute allowance asked for a longer wait than the
//           client sits through. stdout carries one line `retry-after-ms=<n>`: how long the
//           rate gate says to wait before trying again. --out was not written.
//   exit 4: a daily cap is spent (fatal until it resets). --out was not written.
//   (lib/cliExit.js owns exits 3 and 4.)
//
// RATE GATE: forked with an IPC channel (as the app does), every Gemini request first asks
// the parent's rate gate and reports back to it (lib/ipcGate.js); run directly, the script
// uses a gate of its own.
//
// This file is argument handling and file I/O only. It has no generation policy of its
// own: it hands text and language straight to lib/generator.js's createGenerator, the
// same adapter add-audio.js already uses over cardGeneration.ts.

const fs = require('node:fs');
const path = require('node:path');
const { createGenerator } = require('./lib/generator');
const { exitForError } = require('./lib/cliExit');

const USAGE = 'Usage: node generate-clip.js --text <text> --language <code> --out <path.wav> [--reading <text>]\n';

const FLAGS_WITH_VALUES = new Set(['--text', '--language', '--out', '--reading']);

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
 * function and never construct a real client or touch the network.
 *
 * @returns {Promise<number>} the process exit code.
 */
async function run(options, generate) {
  let audio;
  try {
    audio = await generate({ text: options.text, language: options.language, reading: options.reading || '' });
  } catch (error) {
    removeStaleOutput(options.out);
    return exitForError(error);
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
  const { MISSING_KEY_MESSAGE, geminiOptionsFromEnv } = require('./lib/geminiContext');
  const gemini = geminiOptionsFromEnv();
  if (!gemini.apiKey) {
    process.stderr.write(`${MISSING_KEY_MESSAGE}\n`);
    return 1;
  }

  const generate = createGenerator({ ...gemini, log: (line) => process.stderr.write(`${line}\n`) });

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
