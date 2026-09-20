// Guessing which of a note type's fields is "the text to read" and which is
// "where the audio goes" - the same two names amgi_bridge's own fill-audio
// dialog asks a person to confirm (see anki/addon/amgi_bridge/README.md,
// "Field mapping"). A guess is only ever a default: a note type is the
// user's own, not ours, so this must stay visible and overridable rather
// than silently deciding for them.
//
// This mirrors plusaudio/lib/deck.js's resolveFields *by policy*, not by
// import: that module requires node:crypto at its top level for an unrelated
// export (fieldChecksum), which webpack cannot put in a browser bundle, and
// this file has to run in the browser (the add-card form renders the guess
// before anything is submitted to the server). Keeping the two in sync is a
// judgment call, not a mechanical one - see src/__tests__/utils/ankiFields.test.js,
// which checks this file's guesses against deck.js's own resolveFields directly.

// Exact-name match (a field literally called "Audio", "Sound", ...) plus a
// suffix match for a compound name like "CueAudio"/"TargetAudio" - the amgi
// Listening note type's own two audio fields (see anki/README.md's field
// table). A note type can have more than one audio-looking field, unlike the
// single-audio-field decks plusaudio/lib/deck.js's resolveFields was written
// for, which is why this lives here rather than folding into that function.
const AUDIO_FIELD_EXACT = /^(audio|sound|pronunciation|tts|speech)$/i;
const AUDIO_FIELD_SUFFIX = /(audio|sound)$/i;
const TEXT_FIELD_NAMES =
  /^(korean|japanese|chinese|target|foreign|learning|term|word|expression|sentence|front|text)$/i;
const KNOWN_FIELD_NAMES = /^(known|native|meaning|translation|definition|gloss|english|back|cue|prompt)$/i;

function isAudioFieldName(name) {
  return AUDIO_FIELD_EXACT.test(name) || AUDIO_FIELD_SUFFIX.test(name);
}

/** The field name an audio field is "for", by stripping its own Audio/Sound suffix - "TargetAudio" -> "Target". */
function audioFieldStem(name) {
  return name.replace(/(audio|sound)$/i, '');
}

/**
 * @param {{fieldNames: string[], sortFieldIndex: number}} notetype
 * @returns {{textIndex: number|null, audioIndex: number|null, cueAudioIndex: number|null}}
 */
export function guessFields(notetype) {
  const names = notetype?.fieldNames || [];
  const audioLikeIndices = names.reduce((acc, name, i) => {
    if (isAudioFieldName(name)) acc.push(i);
    return acc;
  }, []);

  let audioIndex = audioLikeIndices[0] ?? -1;

  let textIndex = names.findIndex((name, i) => i !== audioIndex && TEXT_FIELD_NAMES.test(name));
  if (textIndex === -1 && notetype.sortFieldIndex !== audioIndex && notetype.sortFieldIndex < names.length) {
    textIndex = notetype.sortFieldIndex;
  }
  if (textIndex === -1) textIndex = names.findIndex((_name, i) => i !== audioIndex);

  // Two (or more) audio-looking fields - this is the CueAudio/TargetAudio
  // shape, not the single-audio-field shape resolveFields handles. The one
  // that reads aloud (audioIndex) is whichever is literally "<the read-aloud
  // field's name>Audio/Sound" (TargetAudio for Target); everything else
  // falls back to field order, since the note type's documented layout
  // (Cue, CueAudio, Target, TargetAudio) puts an audio field right after the
  // text field it belongs to.
  let cueAudioIndex = -1;
  if (audioLikeIndices.length >= 2) {
    const textName = textIndex === -1 ? '' : names[textIndex];
    const stemMatch = audioLikeIndices.find((i) => audioFieldStem(names[i]).toLowerCase() === textName.toLowerCase());
    const afterText = audioLikeIndices.find((i) => i > textIndex);
    audioIndex = stemMatch ?? afterText ?? audioLikeIndices[0];
    cueAudioIndex = audioLikeIndices.find((i) => i !== audioIndex) ?? -1;
  }

  return {
    textIndex: textIndex === -1 ? null : textIndex,
    audioIndex: audioIndex === -1 ? null : audioIndex,
    cueAudioIndex: cueAudioIndex === -1 ? null : cueAudioIndex,
  };
}

/**
 * Guesses which field holds the known-language side, for the text-generation
 * feature (see CardForm.js) and for CueAudio (the known-language prompt clip
 * generated from that same field's text). A note type earns this fourth role
 * alongside guessFields' text/audio/cueAudio guesses: the field a name
 * pattern claims, or failing that the first field none of the other guesses
 * already claimed - same "guess, never silently decide" rule guessFields
 * itself follows, so this is always shown and changeable rather than assumed.
 *
 * @param {{fieldNames: string[]}} notetype
 * @param {number|null} textIndex
 * @param {number|null} audioIndex
 * @param {number|null} cueAudioIndex
 * @returns {number|null}
 */
export function guessKnownFieldIndex(notetype, textIndex, audioIndex, cueAudioIndex = null) {
  const names = notetype?.fieldNames || [];
  const taken = (i) => i === textIndex || i === audioIndex || i === cueAudioIndex;
  let index = names.findIndex((name, i) => !taken(i) && KNOWN_FIELD_NAMES.test(name));
  if (index === -1) {
    index = names.findIndex((_name, i) => !taken(i));
  }
  return index === -1 ? null : index;
}

/** Strip markup for a plain-text preview - good enough for a browsing list, not a rendering engine. */
export function stripHtmlForPreview(html) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a field's raw HTML already contains a sound reference, sound or html form. */
export function hasAudioReference(fieldText) {
  return /\[sound:[^\]]*\]/.test(fieldText || '') || /<audio\b[^>]*src=/i.test(fieldText || '');
}
