#!/usr/bin/env node
'use strict';

// Add generated audio to an .apkg without changing anything else about it.
//
//   node add-audio.js <deck.apkg> [--out <deck with audio.apkg>] [options]
//
// The output is the input with audio added: the same note GUIDs, the same note
// and card ids, the same note types, the same deck names and a byte-identical
// review log. Importing it into the collection the deck came from updates those
// notes in place and leaves their scheduling alone. Running it again generates
// only the audio whose text has changed since last time.

const path = require('node:path');
const { augmentPackage } = require('./lib/augment');
const { AUDIO_TAG_FORMS } = require('./lib/deck');
const { UnsupportedPackageError } = require('./lib/package');
const { createGenerator } = require('./lib/generator');

const USAGE = `Usage: node add-audio.js <deck.apkg> [options]

  --out <path>          output package (default: "<input> (with audio).apkg")
  --text-field <name>   field to read aloud (name or 0-based index)
  --audio-field <name>  field to write the clip reference into (name or index)
  --audio-tag <form>    sound: [sound:clip.mp3] (default, Anki plays it itself)
                        html:  <audio src="clip.mp3"></audio>, which the anki/
                               card template can read and drive
  --language <tag>      language of the text being spoken (default: ko)
  --cache-dir <dir>     clips kept between runs (default: ./plusaudio-audio)
  --limit <n>           generate at most n clips this run
  --dry-run             report what would be generated; write nothing
`;

const FLAGS_WITH_VALUES = new Set([
  '--out',
  '--text-field',
  '--audio-field',
  '--audio-tag',
  '--language',
  '--cache-dir',
  '--limit',
]);

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function defaultOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base} (with audio).apkg`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.positional.length !== 1) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 1;
  }

  const inputPath = options.positional[0];
  const outputPath = options.out ?? defaultOutputPath(inputPath);
  const dryRun = options.dryRun === true;
  const audioTag = options['audio-tag'] ?? 'sound';
  if (!AUDIO_TAG_FORMS.includes(audioTag)) {
    process.stderr.write(`--audio-tag must be one of ${AUDIO_TAG_FORMS.join(', ')}\n`);
    return 1;
  }

  let generate = () => {
    throw new Error('OPENAI_API_KEY is not set');
  };
  if (!dryRun) {
    // Required lazily so --dry-run and the tests never need the sdk or a key.
    const OpenAI = require('openai');
    try {
      process.loadEnvFile(path.join(__dirname, '.env'));
    } catch {
      // No .env next to the CLI; the environment is expected to carry the key.
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      process.stderr.write('OPENAI_API_KEY is not set; use --dry-run to see the plan.\n');
      return 1;
    }
    generate = createGenerator(new OpenAI({ apiKey }), { log: (line) => console.log(line) });
  }

  const summary = await augmentPackage({
    inputPath,
    outputPath,
    generate,
    dryRun,
    language: options.language ?? 'ko',
    textField: options['text-field'],
    audioField: options['audio-field'],
    audioTag,
    cacheDir: options['cache-dir'] ?? path.join(process.cwd(), 'plusaudio-audio'),
    limit: options.limit ? Number(options.limit) : Infinity,
    log: (line) => console.log(line),
  });

  console.log('');
  console.log(`package format:   ${summary.format}`);
  console.log(`audio tag:        ${audioTag}`);
  console.log(`notes:            ${summary.notesTotal}`);
  console.log(`already current:  ${summary.audioUpToDate}`);
  console.log(`clips from cache: ${summary.audioFromCache}`);
  console.log(`clips generated:  ${summary.audioGenerated}${dryRun ? ' (would be)' : ''}`);
  console.log(`notes updated:    ${summary.notesChanged}`);
  console.log(`media added:      ${summary.mediaAdded}`);
  if (summary.skipped.length > 0) {
    console.log(`skipped:          ${summary.skipped.length}`);
    for (const item of summary.skipped.slice(0, 10)) {
      console.log(`  note ${item.id}: ${item.reason}`);
    }
    if (summary.skipped.length > 10) console.log(`  ... and ${summary.skipped.length - 10} more`);
  }
  console.log(dryRun ? '\nnothing written (--dry-run)' : `\nwrote ${outputPath}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UnsupportedPackageError) process.stderr.write(`${error.message}\n`);
      else process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, defaultOutputPath };
