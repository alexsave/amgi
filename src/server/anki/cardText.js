// Generating both sides of a card - and, in the same call, its audio - for
// the add-note screen (see CardForm.js). Shelling out to
// plusaudio/generate-card-text.js mirrors audio.js's own reasoning:
// cardGeneration.ts is a plain TypeScript file with no build step, which has
// no place in this app's server bundle even with plusaudio itself now a
// workspace package (see audio.js's module comment for the fuller version of
// that argument). A subprocess keeps the boundary real for text the same way
// it already does for audio.
//
// THE ONE-PASS RULE. spoken_reading exists only in the object
// generateCardTextOnly returns - no Anki field stores it, so a second, later
// call to generate audio would have nothing left to steer the synthesiser
// with. generateCardTextAndAudio is the only place that reading is allowed
// to be used: read out of the text-generation result and handed straight to
// generateAndStoreClip in the same request, then discarded. Splitting these
// into "generate text now, generate audio later" throws the reading away for
// good - for Japanese and Chinese that is the difference between the audio
// judge being able to verify a reading and falling back to a transcript
// check that cannot tell one reading of a homograph from another.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateAndStoreClip } from './audio';
import { correctSwappedSides, detectInputLanguage } from './sideOrder';

// Asynchronous for the reason audio.js spells out at its own execFileAsync:
// spawnSync held the entire Node event loop for the length of an OpenAI
// call, so two card requests could never overlap however they were made.
const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUSAUDIO_DIR = path.join(__dirname, '..', '..', '..', 'plusaudio');

/**
 * Generate one card's text - both sides, no audio. Exported on its own so a
 * caller that only wants to look at the text (no audio field mapped yet)
 * never pays for a clip it would not use.
 *
 * Unlike audio, there is no safe mocked stand-in when OPENAI_API_KEY is
 * unset: a placeholder clip is honestly labelled and harmless to save, but a
 * placeholder translation would look like real content in a note field. This
 * throws instead, and the caller surfaces the message as an error rather
 * than a quietly-wrong card.
 *
 * @returns {Promise<{front_text: string, back_text: string, spoken_reading: string}>}
 */
export async function generateCardTextOnly({
  userInput = '',
  knownLanguage,
  learningLanguage,
  currentCard = null,
  regenerateParts = [],
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set; card text was not generated (there is no safe placeholder for generated text, unlike audio).',
    );
  }

  const args = [
    path.join(PLUSAUDIO_DIR, 'generate-card-text.js'),
    '--known', knownLanguage,
    '--learning', learningLanguage,
  ];
  if (userInput) {
    args.push('--input', userInput);
    // Settle the direction here when script can settle it, rather than
    // leaving the model to deduce it from text that may mix two languages.
    const inputLanguage = detectInputLanguage(userInput, knownLanguage, learningLanguage);
    if (inputLanguage) args.push('--input-language', inputLanguage);
  }
  if (currentCard) {
    args.push('--current-front', currentCard.front_text || '');
    args.push('--current-back', currentCard.back_text || '');
    if (currentCard.spoken_reading) args.push('--current-reading', currentCard.spoken_reading);
  }
  if (regenerateParts.length > 0) args.push('--regenerate', regenerateParts.join(','));

  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: PLUSAUDIO_DIR, encoding: 'utf8' }));
  } catch (error) {
    // The generator's own last line of stderr is the message worth showing -
    // it is what the person reads on the failed row - and it arrives on the
    // rejection now rather than on a returned result.
    const lines = (error.stderr || error.message || 'card text generation failed').trim().split('\n');
    throw new Error(lines[lines.length - 1] || 'card text generation failed');
  }
  return JSON.parse(stdout.trim());
}

/**
 * Generate both sides of a card and, in the same call, the learning side's
 * audio - steered by the reading generateCardTextOnly just produced. See this
 * module's own comment for why the two calls must never be pulled apart.
 *
 * `includeCueAudio` also generates the known-language prompt clip (CueAudio
 * on the anki/ card template - see its README's field table) from
 * `front_text`, the side already in the language the learner knows. That
 * side carries no `spoken_reading`: the reading only ever exists to steer
 * pronunciation of the learning-language script (see cardGeneration/
 * cardText.ts's READING_OPAQUE_LANGUAGES), and there is no equivalent
 * ambiguity to resolve in the known language. Doubling the audio calls is a
 * real cost, which is why this is opt-in rather than automatic - see
 * CardForm.js and BulkRun.js for where the person is told about it.
 *
 * @returns {Promise<{front_text: string, back_text: string, spoken_reading: string, audio: {filename: string, reference: string, mocked?: boolean, reason?: string, reused?: boolean}, cueAudio?: {filename: string, reference: string, mocked?: boolean, reason?: string, reused?: boolean}}>}
 */
export async function generateCardTextAndAudio({
  userInput,
  knownLanguage,
  learningLanguage,
  currentCard,
  regenerateParts,
  includeCueAudio = false,
  ops,
}) {
  const generated = await generateCardTextOnly({ userInput, knownLanguage, learningLanguage, currentCard, regenerateParts });
  // Before any audio is made, because the clips are recorded FROM these two
  // strings: a swap caught afterwards would leave two correct sentences with
  // each other's voice.
  const text = correctSwappedSides(generated, learningLanguage);
  const audio = await generateAndStoreClip({
    text: text.back_text,
    language: learningLanguage,
    reading: text.spoken_reading,
    ops,
  });
  if (!includeCueAudio) return { ...text, audio };
  const cueAudio = await generateAndStoreClip({ text: text.front_text, language: knownLanguage, ops });
  return { ...text, audio, cueAudio };
}
