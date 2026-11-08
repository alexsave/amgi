// "Is this line already a card in this deck?" - the one place that question
// is answered, for both ways a card is made: one line in the add box
// (CardForm.js) and many from a paste (BulkRun.js).
//
// A line counts as already there when it matches EITHER side of a card the
// deck has. People type in whichever language comes to mind - the box says
// so ("Type or paste in English or 한국어") - so the line they type is the
// known-language side (Cue) as often as the learning side (Target). The
// check used to read only Target, which is how typing "Where is the
// station?" a second time made a second card: that line is the card's Cue,
// and nothing ever compared it against a Cue.
//
// Matching is lyricsParse.js's normalizeForDedupe on both sides (trailing
// punctuation and spacing do not count, case does - see that module's
// policy). A Cue that carries app-written labels ("date (calendar day)") is
// compared as written, so re-typing the bare "date" is not caught; whether
// that is a duplicate or a request for the other sense is not something
// this check can know.

import { ankiApi } from './ankiApi';
import { existingKeySet, normalizeForDedupe } from './lyricsParse';

/**
 * The dedupe keys of every line the deck already has a card for, from both
 * the known-language (cue) and learning-language (target) fields.
 *
 * @param {string|number} deckId
 * @param {string|number} notetypeId
 * @param {{cue: number, target: number}} idx  field indexes, from amgiNotetype's fieldIndexes
 * @returns {Promise<Set<string>>}
 */
export async function existingLineKeys(deckId, notetypeId, idx) {
  const fields = [idx.cue, idx.target].filter((index) => Number.isInteger(index) && index >= 0);
  const answers = await Promise.all(fields.map((index) => ankiApi.fieldValuesInDeck(deckId, notetypeId, index)));
  return existingKeySet(answers.flatMap((answer) => answer?.values || []));
}

/** Whether `line` is already a card, given the keys existingLineKeys returned. */
export function isAlreadyInDeck(keys, line) {
  return keys.has(normalizeForDedupe(line));
}
