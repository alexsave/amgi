#!/usr/bin/env node
//
// Records the starter deck's clips, once, so they can be committed.
//
//   node scripts/build-starter-audio.js            # fill in whatever is missing
//   node scripts/build-starter-audio.js --check    # report, write nothing
//
// The starter deck exists for people who have downloaded amgi and have no
// OpenAI key - see src/server/anki/starterDeck.js. Everything else in this
// repo generates audio on demand and pays for it per clip; this one deck
// cannot, by definition, so its clips ship with the source. That is the whole
// reason this script exists as a build step rather than as something the app
// does at runtime.
//
// Clips are named by plusaudio's own mediaName(), which is a content hash of
// (audio profile, language, text). That is not a convenience - it is what
// makes these files indistinguishable from clips amgi generated itself, so a
// starter deck's audio is reused rather than re-recorded if the same sentence
// is ever generated again with a key configured.
//
// Needs OPENAI_API_KEY (in the environment or plusaudio/.env), and costs one
// TTS call per missing clip - 180 of them from cold.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mediaName } = require('../plusaudio/lib/audio-store');

const ROOT = path.resolve(__dirname, '..');
const PHRASES = path.join(ROOT, 'src', 'data', 'starterPhrases.json');
const OUT_DIR = path.join(ROOT, 'anki', 'starter', 'media');
const GENERATE = path.join(ROOT, 'plusaudio', 'generate-clip.js');

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(PHRASES)) {
    process.stderr.write(`no phrase data at ${PHRASES}\n`);
    process.exit(1);
  }
  const { phrases } = JSON.parse(fs.readFileSync(PHRASES, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const missing = [];
  let have = 0;
  for (const [language, list] of Object.entries(phrases)) {
    for (const text of list) {
      const name = mediaName(text, language);
      if (fs.existsSync(path.join(OUT_DIR, name))) have += 1;
      else missing.push({ language, text, name });
    }
  }

  process.stdout.write(`${have} clips already recorded, ${missing.length} missing\n`);
  if (checkOnly || missing.length === 0) {
    process.exit(missing.length === 0 || checkOnly ? 0 : 1);
  }

  let failed = 0;
  for (const [index, clip] of missing.entries()) {
    const tmp = path.join(os.tmpdir(), `amgi-starter-${process.pid}-${index}.mp3`);
    const result = spawnSync(
      process.execPath,
      [GENERATE, '--text', clip.text, '--language', clip.language, '--out', tmp],
      { cwd: path.join(ROOT, 'plusaudio'), encoding: 'utf8' },
    );
    if (result.status !== 0) {
      failed += 1;
      process.stderr.write(`${clip.language}: ${(result.stderr || '').trim().split('\n').pop()}\n`);
      continue;
    }
    // Written under the final name only after a successful call, so an
    // interrupted run leaves no half-file that a later run would count as
    // already recorded.
    fs.renameSync(tmp, path.join(OUT_DIR, clip.name));
    process.stdout.write(`${index + 1}/${missing.length} ${clip.language}\n`);
  }

  process.stdout.write(failed ? `${failed} clips failed\n` : 'all clips recorded\n');
  process.exit(failed ? 1 : 0);
}

main();
