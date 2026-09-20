// Generating a clip for a note field and attaching it as media - the seam
// the task asked to be stubbed rather than dialed out to a real OpenAI
// account this checkout does not have a key for.
//
// Shelling out to plusaudio/generate-clip.js (rather than requiring
// plusaudio/lib/generator.js in-process) is deliberate, for the same reason
// anki/addon/amgi_bridge/generator.py does it: lib/generator.js itself
// requires plusaudio/lib/cardGeneration/cardGeneration.ts, a plain
// TypeScript file with no build step (Node strips the types at require()
// time), which has no place in this app's server bundle even with plusaudio
// itself now a workspace package - see next.config.js's
// `serverExternalPackages` comment for what that option does and does not
// change. A subprocess keeps that boundary real.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaName } from 'plusaudio/lib/audio-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUSAUDIO_DIR = path.join(__dirname, '..', '..', '..', 'plusaudio');

/**
 * A clearly-fake clip, used whenever a real OpenAI call is not available or
 * not desired (no key configured, or the real generator itself failed). Its
 * bytes say what it is in plain text rather than pretending to be audio, so
 * nothing downstream can mistake it for a real clip if this ever leaked past
 * the "mocked: true" flag callers are given alongside it.
 */
function stubClip(text, language, reason) {
  return Buffer.from(
    `AMGI MOCK AUDIO CLIP - not playable audio\nreason: ${reason}\nlanguage: ${language}\ntext: ${text}\n`,
    'utf8',
  );
}

/**
 * Generate one clip for `text` in `language`. Never makes a network call
 * when OPENAI_API_KEY is unset (checked here, before generate-clip.js would
 * check it again) - that is what keeps this safe to run in this checkout,
 * which has no key, and is exactly the situation a first-run user with no
 * key configured yet will also be in.
 *
 * `reading` is optional: how `text` must be read aloud, in its own script,
 * for languages whose spelling does not fix the pronunciation (see
 * cardText.ts's READING_OPAQUE_LANGUAGES). It only ever comes from the same
 * text-generation call that produced it (see cardText.js's
 * generateCardTextAndAudio) - no Anki field stores one, so there is nowhere
 * else it could come from.
 *
 * @returns {Promise<{data: Buffer, mocked: boolean, reason?: string}>}
 */
export async function generateClip({ text, language, reading = '' }) {
  if (!process.env.OPENAI_API_KEY) {
    const reason = 'OPENAI_API_KEY is not set; generated a stub clip instead of calling OpenAI.';
    return { data: stubClip(text, language, reason), mocked: true, reason };
  }

  const outPath = path.join(os.tmpdir(), `amgi-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const args = [path.join(PLUSAUDIO_DIR, 'generate-clip.js'), '--text', text, '--language', language, '--out', outPath];
  if (reading) args.push('--reading', reading);
  const result = spawnSync(process.execPath, args, { cwd: PLUSAUDIO_DIR, encoding: 'utf8' });

  if (result.status !== 0) {
    const reason = (result.stderr || 'audio generation failed').trim().split('\n')[0];
    return { data: stubClip(text, language, reason), mocked: true, reason };
  }

  const data = fs.readFileSync(outPath);
  fs.unlinkSync(outPath);
  return { data, mocked: false };
}

/**
 * Generate a clip and add it to the current collection's media, returning the
 * stored filename.
 *
 * The filename is content-hashed on (language, text) (see audio-store.js's
 * mediaName), so if a clip for this exact text already exists - a previous
 * run that got this far before being cancelled, or a second pass over a deck
 * that already has some audio - there is nothing to generate. Checking
 * `ops.hasMedia` before calling out to the real generator is what makes that
 * true in practice, not just in principle: generateClip() itself has no way
 * to know a file already exists, so skipping the call here is the only place
 * a re-run actually avoids paying for a clip it would immediately discard.
 *
 * `reading` is not part of the cache key. It cannot be - the filename has to
 * stay stable for the same (language, text) so a note's [sound:...] tag
 * never needs rewriting - but that means a cache hit on `text` reuses
 * whichever reading (if any) produced the clip on disk today, even if a
 * later generation of the same text returned a different one. That is a real
 * gap, not a new one: audio regenerated with no reading at all already has
 * this problem (see generateCardAudio's own doc comment), and a same-text
 * reading disagreement across generations should be rare in practice.
 */
export async function generateAndStoreClip({ text, language, reading = '', ops }) {
  const desiredName = mediaName(text, language);
  if (await ops.hasMedia(desiredName)) {
    return { filename: desiredName, mocked: false, reused: true };
  }
  const { data, mocked, reason } = await generateClip({ text, language, reading });
  const filename = await ops.addMedia(desiredName, data);
  return { filename, mocked, reason };
}
