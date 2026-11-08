#!/usr/bin/env node
//
// Records the starter deck's clips, so they can be committed.
//
//   node scripts/build-starter-audio.js              # record whatever is missing
//   node scripts/build-starter-audio.js --rerecord   # record every clip again
//   node scripts/build-starter-audio.js --check      # report, write nothing
//   ... --only ja,ko                                 # limit to some languages
//   ... --model gemini-3.8-flash-lite-tts            # another named TTS model (see below)
//
// The starter deck exists for people who have downloaded amgi and have no
// Gemini key - see src/server/anki/starterDeck.js. Everything else in this
// repo generates audio on demand and pays for it per clip; this one deck
// cannot, by definition, so its clips ship with the source. That is the whole
// reason this script exists as a build step rather than as something the app
// does at runtime. It is a dev tool: nothing at runtime runs it or needs what
// it needs (ffmpeg).
//
// HOW A CLIP IS MADE. Through the real pipeline, in process - Gemini speech,
// then the same transcription check and, on a mismatch, the same audio judge
// every card gets (cardGeneration.ts's generateCardAudio). The starter phrases
// carry no stored reading, so Japanese and Chinese clips are checked by
// transcript, and judged only on a mismatch, exactly as a re-recorded card is.
// A clip that does not validate is NOT shipped: the run lists it and exits 1,
// and nothing under anki/starter/ changes until every clip asked for has
// validated.
//
// MODEL. The speech model defaults to the runtime one (models.ts's
// GEMINI_TTS_MODEL); --model picks another of models.ts's named TTS
// constants and nothing else. The owner chose GEMINI_TTS_LITE_MODEL for the
// starter clips. Transcription and the judge stay on the runtime models, so
// every clip is checked exactly as a card would be. The model is recorded per
// clip in voices.tsv, and a cached take made with a different model is
// recorded again rather than reused.
//
// DAILY CAPS. A per-day cap on any model stops the run at once (another clip
// would only be refused too): the cache keeps what passed, the run reports
// how many clips are done and how many remain, and nothing is shipped.
//
// VOICES. Each clip's voice is drawn from models.ts's GEMINI_TTS_VOICES by a
// generator seeded from STARTER_SEED and the clip's own name, through
// plusaudio/lib/random.js - so the same seed gives the same voice for the
// same clip on every run, however the run was interrupted and resumed. A
// retry inside the pipeline draws a different voice, from the same generator.
// anki/starter/voices.tsv records which model and voice made each clip.
//
// RE-RUNNABLE. Each validated clip is kept as WAV in .cache/starter-audio/
// (gitignored) as soon as it passes, so an interrupted or partly failed run
// picks up where it stopped and never pays twice for a clip.
//
// SIZE. The shipped clips are mp3, about 64 kbps mono, converted from the
// validated WAV with ffmpeg here at build time: a WAV starter set would be
// about 48 KB per second of speech in the repo instead of about 8. The app
// plays both formats; only these shipped files are mp3.
//
// NAMES. Clips are named by plusaudio's own mediaName() - a content hash of
// (audio profile, language, text) - with the mp3 extension, so starterDeck.js
// finds them by the same hash amgi would give the sentence, and the names
// never change when a clip is re-recorded.
//
// Needs GEMINI_API_KEY (in the environment or plusaudio/.env) and ffmpeg.
// Costs one Gemini TTS call plus its checks per clip - 180 clips from cold,
// far past the free tier's 10 requests per model per day.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PHRASES = path.join(ROOT, 'src', 'data', 'starterPhrases.json');
const OUT_DIR = path.join(ROOT, 'anki', 'starter', 'media');
const MANIFEST = path.join(ROOT, 'anki', 'starter', 'voices.tsv');
const CACHE = path.join(ROOT, '.cache', 'starter-audio');

const { STARTER_EXTENSION, starterClipName } = require('../plusaudio/lib/audio-store');

/** The one seed the starter voices are drawn from. Change it to re-roll every voice. */
const STARTER_SEED = 20261108;

const MP3_BITRATE = '64k';

function parseArgs(argv) {
  const { GEMINI_TTS_MODEL, GEMINI_TTS_LITE_MODEL } = require('../plusaudio/lib/cardGeneration/models.ts');
  const named = [GEMINI_TTS_MODEL, GEMINI_TTS_LITE_MODEL];
  const options = { rerecord: false, check: false, only: null, model: GEMINI_TTS_MODEL };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--rerecord') options.rerecord = true;
    else if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--only') options.only = new Set((argv[++i] || '').split(',').filter(Boolean));
    else if (argv[i] === '--model') {
      options.model = argv[++i];
      if (!named.includes(options.model)) throw new Error(`--model must be one of ${named.join(', ')}`);
    } else throw new Error(`unknown option ${argv[i]}`);
  }
  return options;
}

/** A refusal no wait inside this run fixes: a per-day cap (gemini.ts's dailyQuotaMessage). */
function isDailyCap(message) {
  return /daily limit|requests per day per model/.test(message);
}

/** A clip's own seed: STARTER_SEED and its name, so a resumed run draws the same voice. */
function clipSeed(name) {
  return (STARTER_SEED ^ crypto.createHash('sha1').update(name).digest().readUInt32LE(0)) >>> 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readTakes() {
  const takes = new Map();
  const file = path.join(CACHE, 'takes.tsv');
  if (!fs.existsSync(file)) return takes;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const [name, language, model, voice, attempts] = line.split('\t');
    takes.set(name, { name, language, model, voice, attempts: Number(attempts) });
  }
  return takes;
}

async function recordClip(clip, { apiKey, baseUrl, model }) {
  const { createGeminiContext } = require('../plusaudio/lib/geminiContext');
  const { generateCardAudio } = require('../plusaudio/lib/cardGeneration/cardGeneration.ts');
  const { createRandom } = require('../plusaudio/lib/random');

  const warnings = [];
  const context = createGeminiContext({ apiKey, baseUrl, ttsModel: model, random: createRandom(clipSeed(clip.name)), log: (line) => warnings.push(line.trim()) });
  const voices = [];
  const pickVoice = context.speech.pickVoice;
  context.speech = { ...context.speech, pickVoice: (previous) => { const voice = pickVoice(previous); voices.push(voice); return voice; } };

  for (;;) {
    voices.length = 0;
    try {
      const audio = await generateCardAudio(context, { text: clip.text, language: clip.language });
      return { audio: Buffer.from(audio), voice: voices[voices.length - 1], attempts: voices.length, model: context.models.tts, warnings };
    } catch (error) {
      // A per-minute limit is a quota, not a verdict on the clip: wait it out.
      if (/per minute/.test(error.message)) {
        process.stdout.write('  (per-minute limit; waiting 60 s)\n');
        await sleep(60_000);
        continue;
      }
      return { error: error.message, dailyCap: isDailyCap(error.message), attempts: voices.length, warnings };
    }
  }
}

function toMp3(wavPath, mp3Path) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, mp3Path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed on ${wavPath}: ${(result.stderr || result.error?.message || '').trim()}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { phrases } = JSON.parse(fs.readFileSync(PHRASES, 'utf8'));

  const clips = [];
  for (const [language, list] of Object.entries(phrases)) {
    if (options.only && !options.only.has(language)) continue;
    for (const text of list) clips.push({ language, text, name: starterClipName(text, language) });
  }
  const shipped = (clip) => fs.existsSync(path.join(OUT_DIR, clip.name));
  const wanted = clips.filter((clip) => options.rerecord || !shipped(clip));
  process.stdout.write(`${clips.length - clips.filter((clip) => !shipped(clip)).length} of ${clips.length} clips shipped; ${wanted.length} to record with ${options.model}\n`);
  if (options.check || wanted.length === 0) return wanted.length === 0 || options.check ? 0 : 1;

  try {
    process.loadEnvFile(path.join(ROOT, 'plusaudio', '.env'));
  } catch {
    // No plusaudio/.env; the environment is expected to carry the key.
  }
  const { geminiOptionsFromEnv } = require('../plusaudio/lib/geminiContext');
  const { apiKey, baseUrl } = geminiOptionsFromEnv();
  if (!apiKey) {
    process.stderr.write('GEMINI_API_KEY is not set.\n');
    return 1;
  }

  fs.mkdirSync(CACHE, { recursive: true });
  const takes = readTakes();
  const failed = [];
  for (const [index, clip] of wanted.entries()) {
    const stem = clip.name.replace(/\.[^.]+$/, '');
    const cached = path.join(CACHE, `${stem}.wav`);
    if (fs.existsSync(cached) && takes.get(clip.name)?.model === options.model) {
      process.stdout.write(`${index + 1}/${wanted.length} ${clip.language} cached (${takes.get(clip.name).voice})\n`);
      continue;
    }
    const result = await recordClip(clip, { apiKey, baseUrl, model: options.model });
    if (result.dailyCap) {
      const done = wanted.filter((c) => takes.get(c.name)?.model === options.model && fs.existsSync(path.join(CACHE, `${c.name.replace(/\.[^.]+$/, '')}.wav`))).length;
      process.stderr.write(`\nStopped at a daily cap: ${result.error}\n`);
      process.stderr.write(`${done} of ${wanted.length} clips are validated and cached; ${wanted.length - done} remain. Nothing under anki/starter/ was changed; run again after the reset to continue.\n`);
      return 1;
    }
    if (result.error) {
      failed.push({ ...clip, error: result.error, attempts: result.attempts });
      process.stdout.write(`${index + 1}/${wanted.length} ${clip.language} FAILED after ${result.attempts} attempt(s): ${result.error}\n`);
      continue;
    }
    fs.writeFileSync(cached, result.audio);
    fs.appendFileSync(path.join(CACHE, 'takes.tsv'), `${clip.name}\t${clip.language}\t${result.model}\t${result.voice}\t${result.attempts}\n`);
    takes.set(clip.name, { name: clip.name, language: clip.language, model: result.model, voice: result.voice, attempts: result.attempts });
    process.stdout.write(`${index + 1}/${wanted.length} ${clip.language} ${result.voice}${result.attempts > 1 ? ` (${result.attempts} attempts)` : ''}\n`);
  }

  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} clip(s) did not validate; nothing under anki/starter/ was changed:\n`);
    for (const clip of failed) process.stderr.write(`  ${clip.language} "${clip.text}": ${clip.error}\n`);
    return 1;
  }

  for (const clip of wanted) {
    const stem = clip.name.replace(/\.[^.]+$/, '');
    toMp3(path.join(CACHE, `${stem}.wav`), path.join(OUT_DIR, clip.name));
  }

  // Which model and voice made each shipped clip, in phrase order.
  const rows = clips.map((clip) => {
    const take = takes.get(clip.name);
    return [clip.name, clip.language, take ? take.model : 'unknown', take ? take.voice : 'unknown', take ? take.attempts : '', clip.text].join('\t');
  });
  fs.writeFileSync(MANIFEST, `${['file', 'language', 'model', 'voice', 'attempts', 'text'].join('\t')}\n${rows.join('\n')}\n`);
  process.stdout.write(`converted ${wanted.length} clip(s) to ${STARTER_EXTENSION} at ${MP3_BITRATE}; wrote ${path.relative(ROOT, MANIFEST)}\n`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
