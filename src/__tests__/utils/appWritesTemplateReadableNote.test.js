// The seam this whole feature is about: a note the app builds has to be one
// the anki/ card template can actually play, with the right clip in the
// right field. Neither side's own unit tests catch that on their own - the
// field-mapping guess (ankiFields.js) and the audio rendering (plusaudio/lib/
// deck.js) are both individually correct and still produced a broken card
// (see the task this test was written for: CueAudio never populated, and a
// previous fix attempt swapped which language went into which field). This
// test builds a note the way CardForm.js's "Generate Audio" actually does -
// same field-mapping guess, same renderAudioReference call - and checks it
// against the real template files' own field names and reference format,
// not against another copy of the same assumption.

import fs from 'node:fs';
import path from 'node:path';
import { guessFields, guessKnownFieldIndex } from '../../utils/ankiFields';

const { audioReferences, renderAudioReference } = require('../../../plusaudio/lib/deck');
const { mediaName } = require('../../../plusaudio/lib/audio-store');

const ANKI_DIR = path.join(__dirname, '..', '..', '..', 'anki');

/** Every {{Field}} (and {{#Field}}) the template's own markup reads. */
function fieldsReferencedBy(templateFile) {
  const html = fs.readFileSync(path.join(ANKI_DIR, 'notetype', templateFile), 'utf8');
  return new Set([...html.matchAll(/\{\{#?(\w+)\}\}/g)].map((m) => m[1]));
}

// The note type's field order, exactly as anki/README.md's install step
// documents it (Cue, CueAudio, Target, TargetAudio, Language, Notes).
const AMGI_NOTETYPE = {
  name: 'amgi Listening',
  fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'],
  sortFieldIndex: 0,
};

describe('a note the app builds for the amgi Listening note type', () => {
  const guess = guessFields(AMGI_NOTETYPE);
  const knownFieldIndex = guessKnownFieldIndex(AMGI_NOTETYPE, guess.textIndex, guess.audioIndex, guess.cueAudioIndex);

  test('the field-mapping guess lands on the fields the templates actually render', () => {
    const frontFields = fieldsReferencedBy('front.html');
    const backFields = fieldsReferencedBy('back.html');

    // The front side renders only CueAudio (see front.html's own comment on
    // why the answer text may never appear there) - guessFields' cueAudioIndex
    // has to point at that exact field, or the front side stays silent.
    expect(frontFields).toEqual(new Set(['CueAudio']));
    expect(AMGI_NOTETYPE.fieldNames[guess.cueAudioIndex]).toBe('CueAudio');
    expect(frontFields.has(AMGI_NOTETYPE.fieldNames[guess.cueAudioIndex])).toBe(true);

    // The back side renders both audio fields plus the two text fields.
    expect(backFields.has(AMGI_NOTETYPE.fieldNames[guess.audioIndex])).toBe(true);
    expect(AMGI_NOTETYPE.fieldNames[guess.audioIndex]).toBe('TargetAudio');
    expect(backFields.has(AMGI_NOTETYPE.fieldNames[guess.textIndex])).toBe(true);
    expect(AMGI_NOTETYPE.fieldNames[guess.textIndex]).toBe('Target');
    expect(backFields.has(AMGI_NOTETYPE.fieldNames[knownFieldIndex])).toBe(true);
    expect(AMGI_NOTETYPE.fieldNames[knownFieldIndex]).toBe('Cue');
  });

  test('CueAudio gets the known-language clip and TargetAudio gets the learning-language clip - never swapped', () => {
    // Ordinary Korean practice sentences, not the owner's lyric file.
    const knownLanguage = 'en';
    const learningLanguage = 'ko';
    const knownText = 'I am a little tired today.';
    const learningText = '오늘 저는 조금 피곤해요.';

    // What CardForm.js's handleGenerate does: one clip per side, each
    // rendered with plusaudio/lib/deck's own renderAudioReference (the app
    // never hand-builds this HTML - see src/server/anki/audio.js).
    const cueFilename = mediaName(knownText, knownLanguage);
    const targetFilename = mediaName(learningText, learningLanguage);
    const fields = AMGI_NOTETYPE.fieldNames.map(() => '');
    fields[knownFieldIndex] = knownText;
    fields[guess.textIndex] = learningText;
    fields[guess.cueAudioIndex] = renderAudioReference(cueFilename, 'html');
    fields[guess.audioIndex] = renderAudioReference(targetFilename, 'html');

    const cueRefs = audioReferences(fields[guess.cueAudioIndex]);
    const targetRefs = audioReferences(fields[guess.audioIndex]);

    expect(cueRefs).toHaveLength(1);
    expect(targetRefs).toHaveLength(1);

    // Reference form: html, never [sound:...] - the anki/ card template
    // cannot see a sound tag at all (Anki strips it before any template
    // JavaScript runs), so a regression back to that form would look fine in
    // the note editor and play nothing on the card.
    expect(cueRefs[0].form).toBe('html');
    expect(targetRefs[0].form).toBe('html');
    expect(fields[guess.cueAudioIndex]).not.toMatch(/\[sound:/);
    expect(fields[guess.audioIndex]).not.toMatch(/\[sound:/);

    // The actual regression this guards: which language's clip landed in
    // which field. A filename is a hash of (text, language), so the only way
    // these two match what they are supposed to is if the known-language
    // text was actually spoken in the known language, and likewise for the
    // learning side.
    expect(cueRefs[0].name).toBe(mediaName(knownText, knownLanguage));
    expect(targetRefs[0].name).toBe(mediaName(learningText, learningLanguage));
    expect(cueRefs[0].name).not.toBe(mediaName(learningText, learningLanguage));
    expect(targetRefs[0].name).not.toBe(mediaName(knownText, knownLanguage));
    expect(cueRefs[0].name).not.toBe(targetRefs[0].name);
  });
});
