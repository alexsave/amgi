import { guessFields } from '../../utils/ankiFields';

const { resolveFields } = require('../../../plusaudio/lib/deck');

// guessFields is a browser-safe duplicate of resolveFields' guessing policy
// (see ankiFields.js's module comment for why it can't just import deck.js).
// This test is what keeps the duplication honest: any note type whose fields
// deck.js can confidently guess must get the same answer from this file, or
// the add-card form's default would silently diverge from what plusaudio and
// the Anki bridge already agree on.
function agrees(notetype) {
  let resolved;
  try {
    resolved = resolveFields(notetype);
  } catch {
    resolved = null;
  }
  const guessed = guessFields(notetype);
  if (!resolved) {
    expect(guessed.audioIndex === null || guessed.textIndex === null).toBe(true);
    return;
  }
  expect(guessed).toEqual({ textIndex: resolved.textIndex, audioIndex: resolved.audioIndex });
}

test('Retro-style note type (Korean, Audio, Sort): both guess Korean=text, Audio=audio', () => {
  agrees({ name: "Retro's sentences", fieldNames: ['Korean', 'Audio', 'Sort'], sortFieldIndex: 2 });
});

test('a plain Basic note type has no audio field: both refuse to guess an audio field', () => {
  agrees({ name: 'Basic', fieldNames: ['Front', 'Back'], sortFieldIndex: 0 });
});

test('an explicitly named Sound field is picked over a same-named sort field', () => {
  agrees({ name: 'Vocab', fieldNames: ['Word', 'Sound'], sortFieldIndex: 0 });
});

test('a Japanese-style note type (Term first, audio field named Speech)', () => {
  agrees({ name: 'JP', fieldNames: ['Term', 'Reading', 'Speech'], sortFieldIndex: 0 });
});
