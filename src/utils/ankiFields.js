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

const AUDIO_FIELD_NAMES = /^(audio|sound|pronunciation|tts|speech)$/i;
const TEXT_FIELD_NAMES =
  /^(korean|japanese|chinese|target|foreign|learning|term|word|expression|sentence|front|text)$/i;

/**
 * @param {{fieldNames: string[], sortFieldIndex: number}} notetype
 * @returns {{textIndex: number|null, audioIndex: number|null}}
 */
export function guessFields(notetype) {
  const names = notetype?.fieldNames || [];

  let audioIndex = names.findIndex((name) => AUDIO_FIELD_NAMES.test(name));

  let textIndex = names.findIndex((name, i) => i !== audioIndex && TEXT_FIELD_NAMES.test(name));
  if (textIndex === -1 && notetype.sortFieldIndex !== audioIndex && notetype.sortFieldIndex < names.length) {
    textIndex = notetype.sortFieldIndex;
  }
  if (textIndex === -1) textIndex = names.findIndex((_name, i) => i !== audioIndex);

  if (audioIndex === -1) audioIndex = null;
  if (textIndex === -1) textIndex = null;
  return { textIndex, audioIndex };
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
