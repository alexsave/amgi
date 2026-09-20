import { hasNativeScript, usesNonLatinScript } from 'plusaudio/lib/cardGeneration/cardText.ts';

/**
 * Put the two sides the right way round when the model got them backwards.
 *
 * `front_text` is the language the learner already knows and `back_text` the
 * one they are learning; the model decides which is which by reading the
 * input, and it gets that wrong on mixed input. A Korean lyric ending in an
 * English phrase - "그대 향해 한 걸음씩 걸어갈래요, still with you" - came back
 * with the Korean as the front and an English translation as the back, so
 * the card asked the learner to produce English, and recorded the English
 * sentence in the Korean voice.
 *
 * Script settles it without asking anyone: if the learning language has a
 * script of its own, the side carrying that script is the learning side, and
 * a back_text with none of it while front_text has plenty is the pair
 * reversed. This cannot help for a Latin-script learning language - Spanish
 * and English share an alphabet - so it does nothing there rather than
 * guessing.
 *
 * `spoken_reading` describes whichever side the model thought was the
 * target, so a swap discards it: a reading for the wrong sentence is worse
 * than none, because it steers the pronunciation of the clip recorded next.
 *
 * It lives in its own file so it can be tested without dragging in the audio
 * pipeline, which is the only other thing generateCardTextAndAudio touches.
 */
export function correctSwappedSides(text, learningLanguage) {
  if (!usesNonLatinScript(learningLanguage)) return text;
  const backIsNative = hasNativeScript(text.back_text, learningLanguage);
  const frontIsNative = hasNativeScript(text.front_text, learningLanguage);
  if (backIsNative || !frontIsNative) return text;
  return {
    ...text,
    front_text: text.back_text,
    back_text: text.front_text,
    spoken_reading: '',
    sidesSwapped: true,
  };
}
