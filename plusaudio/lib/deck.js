'use strict';

// The Anki collection as this tool needs to see it: note types, which of their
// fields hold the text and the audio, and the HTML conventions inside a field.

const crypto = require('node:crypto');

const FIELD_SEPARATOR = '\x1f';
const SOUND_TAG = /\[sound:([^\]]*)\]/g;

const AUDIO_FIELD_NAMES = /^(audio|sound|pronunciation|tts|speech)$/i;
const TEXT_FIELD_NAMES =
  /^(korean|japanese|chinese|target|foreign|learning|term|word|expression|sentence|front|text)$/i;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Mirrors rslib/src/text.rs decode_entities, including its collapse of every
// non-breaking space to an ordinary one. Getting this wrong would put a
// checksum in `notes.csum` that Anki disagrees with.
function decodeEntities(text) {
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    })
    .replace(/ /g, ' ');
}

/**
 * Anki's strip_html_media: drop markup but keep the filename of media tags, so
 * two notes differing only in their media still get different checksums.
 * Used for `notes.sfld` and `notes.csum`, which must match what Anki itself
 * would compute or its duplicate finder and search go wrong until the user runs
 * Check Database.
 */
function stripHtmlPreservingMedia(html) {
  const withFilenames = html.replace(
    /<\s*(?:img|audio|object)\b[^>]*?\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))[^>]*>/gi,
    (_match, dquoted, squoted, bare) => ` ${dquoted ?? squoted ?? bare ?? ''} `,
  );
  return decodeEntities(withFilenames.replace(/<!--.*?-->/gs, '').replace(/<[^>]*>/g, ''));
}

/** The text a note is meant to be read aloud as: no markup, no media, no runs of space. */
function spokenText(html) {
  return decodeEntities(
    html
      .replace(SOUND_TAG, ' ')
      .replace(/<!--.*?-->/gs, '')
      .replace(/<(br|div|p|li|tr|td)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldChecksum(fieldText) {
  const digest = crypto.createHash('sha1').update(stripHtmlPreservingMedia(fieldText), 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16);
}

function splitFields(flds) {
  return flds.split(FIELD_SEPARATOR);
}

function joinFields(fields) {
  return fields.join(FIELD_SEPARATOR);
}

function soundFilenames(fieldText) {
  return [...fieldText.matchAll(SOUND_TAG)].map((m) => m[1]);
}

/**
 * Replace the sound tags this tool owns with a single new one, leaving any
 * other content of the field - images, the deck author's own recordings, plain
 * text - exactly where it was.
 */
function setOwnedSound(fieldText, filename, isOwned) {
  let replaced = false;
  const tag = filename === null ? '' : `[sound:${filename}]`;
  const next = fieldText.replace(SOUND_TAG, (match, name) => {
    if (!isOwned(name)) return match;
    if (replaced) return '';
    replaced = true;
    return tag;
  });
  if (replaced || filename === null) return next;
  return next.length === 0 ? tag : `${next}${tag}`;
}

/** Note types, read from the schema 11 `col.models` JSON blob. */
function readNotetypes(db) {
  const models = JSON.parse(db.prepare('SELECT models FROM col').get().models);
  const notetypes = new Map();
  for (const [id, model] of Object.entries(models)) {
    notetypes.set(Number(id), {
      id: Number(id),
      name: model.name,
      sortFieldIndex: model.sortf ?? 0,
      fieldNames: [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    });
  }
  return notetypes;
}

function findFieldIndex(fieldNames, wanted) {
  if (wanted === undefined || wanted === null) return -1;
  const asIndex = Number(wanted);
  if (Number.isInteger(asIndex) && String(asIndex) === String(wanted).trim()) {
    if (asIndex < 0 || asIndex >= fieldNames.length) {
      throw new Error(`field index ${asIndex} is out of range for a note type with ${fieldNames.length} fields`);
    }
    return asIndex;
  }
  const index = fieldNames.findIndex((name) => name.toLowerCase() === String(wanted).toLowerCase());
  if (index === -1) {
    throw new Error(`no field named "${wanted}"; this note type has ${fieldNames.join(', ')}`);
  }
  return index;
}

/**
 * Decide which field holds the text to speak and which holds the audio.
 *
 * Guessing the audio field wrong overwrites real content, so an unnamed audio
 * field is an error the user has to resolve with --audio-field rather than
 * something to fall back on.
 */
function resolveFields(notetype, { textField, audioField } = {}) {
  const names = notetype.fieldNames;

  let audioIndex = findFieldIndex(names, audioField);
  if (audioIndex === -1) audioIndex = names.findIndex((name) => AUDIO_FIELD_NAMES.test(name));
  if (audioIndex === -1) {
    throw new Error(
      `note type "${notetype.name}" has no field that looks like an audio field ` +
        `(fields: ${names.join(', ')}); pass --audio-field`,
    );
  }

  let textIndex = findFieldIndex(names, textField);
  if (textIndex === -1) {
    textIndex = names.findIndex((name, i) => i !== audioIndex && TEXT_FIELD_NAMES.test(name));
  }
  if (textIndex === -1 && notetype.sortFieldIndex !== audioIndex) {
    textIndex = notetype.sortFieldIndex;
  }
  if (textIndex === -1) textIndex = names.findIndex((_name, i) => i !== audioIndex);
  if (textIndex === -1) {
    throw new Error(`note type "${notetype.name}" has no field to read aloud`);
  }
  if (textIndex === audioIndex) {
    throw new Error(`note type "${notetype.name}": text and audio field are the same field`);
  }

  return { textIndex, audioIndex };
}

module.exports = {
  FIELD_SEPARATOR,
  decodeEntities,
  fieldChecksum,
  joinFields,
  readNotetypes,
  resolveFields,
  setOwnedSound,
  soundFilenames,
  spokenText,
  splitFields,
  stripHtmlPreservingMedia,
};
