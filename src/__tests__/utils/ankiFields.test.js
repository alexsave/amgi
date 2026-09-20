import { guessFields, guessKnownFieldIndex } from '../../utils/ankiFields';

const { resolveFields } = require('../../../plusaudio/lib/deck');

// guessFields is a browser-safe duplicate of resolveFields' single-audio-field
// guessing policy (see ankiFields.js's module comment for why it can't just
// import deck.js), extended with a second guess resolveFields does not need
// to make: which of two audio-looking fields is the "read aloud" clip and
// which is the cue clip (see guessFields' own comment). This test is what
// keeps the shared part of the duplication honest: any note type with at
// most one audio-looking field must get the same textIndex/audioIndex from
// both, or the add-card form's default would silently diverge from what
// plusaudio and the Anki bridge already agree on. A note type with two or
// more audio-looking fields is deliberately out of scope here - resolveFields
// was never asked to disambiguate that case, only guessFields was.
function agrees(notetype) {
  let resolved;
  try {
    resolved = resolveFields(notetype);
  } catch {
    resolved = null;
  }
  const { textIndex, audioIndex } = guessFields(notetype);
  if (!resolved) {
    expect(audioIndex === null || textIndex === null).toBe(true);
    return;
  }
  expect({ textIndex, audioIndex }).toEqual({ textIndex: resolved.textIndex, audioIndex: resolved.audioIndex });
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

describe('two audio fields (CueAudio/TargetAudio)', () => {
  test('the amgi Listening note type: Target/TargetAudio pair by name, Cue/CueAudio the leftover', () => {
    const notetype = {
      name: 'amgi Listening',
      fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'],
      sortFieldIndex: 0,
    };
    const guess = guessFields(notetype);
    expect(guess).toEqual({ textIndex: 2, audioIndex: 3, cueAudioIndex: 1 });
    expect(guessKnownFieldIndex(notetype, guess.textIndex, guess.audioIndex, guess.cueAudioIndex)).toBe(0);
  });

  test('falls back to field order when no audio field name stems match the read-aloud field', () => {
    // 'Speech' and 'Sound' are both audio-looking by the exact-name list, but
    // neither name-matches 'Term' the way 'TargetAudio' name-matches
    // 'Target' - so the guess falls back to "the audio field right after the
    // text field it belongs to", the layout amgi's own note type documents.
    const notetype = { name: 'Custom', fieldNames: ['Meaning', 'Speech', 'Term', 'Sound'], sortFieldIndex: 2 };
    expect(guessFields(notetype)).toEqual({ textIndex: 2, audioIndex: 3, cueAudioIndex: 1 });
  });

  test('a single compound audio field name (WordAudio) is still recognised, with no cue field guessed', () => {
    const notetype = { name: 'Compound', fieldNames: ['Word', 'WordAudio'], sortFieldIndex: 0 };
    expect(guessFields(notetype)).toEqual({ textIndex: 0, audioIndex: 1, cueAudioIndex: null });
  });
});
