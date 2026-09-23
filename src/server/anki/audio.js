// Generating a clip for a note field and attaching it as media.
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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaName } from 'plusaudio/lib/audio-store';
import { renderAudioReference } from 'plusaudio/lib/deck';
import { runPlusaudio } from './plusaudioCli';

/**
 * Generate one clip for `text` in `language`, or throw.
 *
 * There is no placeholder clip, with or without OPENAI_API_KEY. There used
 * to be one: a few lines of text saying "not playable audio", returned
 * whenever there was no key or the real generator failed, with a `mocked`
 * flag beside it. It went into the collection under the clip's real name,
 * and that name is a hash of (language, text) that generateAndStoreClip
 * treats as "already done" - so the placeholder was permanent. A bulk run
 * that hit one failed clip got a card that played nothing, reported success
 * on its row, and would have reused the placeholder on every later attempt.
 * A card with no clip, and an error saying why, is the only honest outcome:
 * it is the same rule cardText.js already applies to generated text.
 *
 * `reading` is optional: how `text` must be read aloud, in its own script,
 * for languages whose spelling does not fix the pronunciation (see
 * cardText.ts's READING_OPAQUE_LANGUAGES). It only ever comes from the same
 * text-generation call that produced it (see cardText.js's
 * generateCardTextAndAudio) - no Anki field stores one, so there is nowhere
 * else it could come from.
 *
 * @returns {Promise<Buffer>} the clip's bytes
 */
export async function generateClip({ text, language, reading = '' }) {
  // Checked here as well as in generate-clip.js so a missing key costs
  // nothing, not even a subprocess.
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set; audio was not generated.');
  }

  const outPath = path.join(os.tmpdir(), `amgi-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const args = ['--text', text, '--language', language, '--out', outPath];
  if (reading) args.push('--reading', reading);
  await runPlusaudio('generate-clip.js', args, 'audio generation failed');

  const data = await fs.readFile(outPath);
  await fs.unlink(outPath);
  return data;
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
 *
 * `reference` is the HTML this app ever writes into a field for this clip -
 * `<audio src="...">`, from plusaudio/lib/deck's own renderAudioReference,
 * never `[sound:...]`. The anki/ card template strips sound tags before its
 * JavaScript can see them (rslib/src/text.rs, AV_TAGS), so a `[sound:]`
 * reference would leave the field looking filled while the template never
 * sees a clip at all - see anki/README.md, "What goes in the audio fields".
 *
 * `fresh` skips the reuse and always records a new take. It is what "Re-record"
 * on a card means (see CardPanel.js): the person heard the clip already on
 * disk for this exact text and wants a different one, so handing that same
 * file back would make the button do nothing. The new take does not replace
 * the old file - other notes may share it - ops.addMedia stores different
 * bytes under a hash-suffixed name instead (media.js's addMediaFile, and
 * Anki's own write_data on the bridge side), and that name is what the
 * returned reference points at.
 */
export async function generateAndStoreClip({ text, language, reading = '', fresh = false, ops }) {
  const desiredName = mediaName(text, language);
  if (!fresh && (await ops.hasMedia(desiredName))) {
    return { filename: desiredName, reference: renderAudioReference(desiredName, 'html'), reused: true };
  }
  const data = await generateClip({ text, language, reading });
  const filename = await ops.addMedia(desiredName, data);
  return { filename, reference: renderAudioReference(filename, 'html') };
}
