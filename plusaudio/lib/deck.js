'use strict';

// The Anki collection as this tool needs to see it: note types, which of their
// fields hold the text and the audio, and the HTML conventions inside a field.

const crypto = require('node:crypto');

const { WIRE_VARINT, readFields } = require('./protobuf');

const FIELD_SEPARATOR = '\x1f';
const SOUND_TAG = /\[sound:([^\]]*)\]/g;
// An <audio> element with a src, closing tag optional, which is what Anki's own
// media tracker treats as a reference (rslib/src/text.rs, HTML_MEDIA_TAGS).
const HTML_AUDIO_TAG =
  /<\s*audio\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))[^>]*>(?:\s*<\/\s*audio\s*>)?/gi;

/** The two ways a note can point at a clip. See README.md, "Which reference to write". */
const AUDIO_TAG_FORMS = ['sound', 'html'];

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

/**
 * Every clip a field points at, in either form, in the order they appear.
 * @returns {Array<{name: string, form: 'sound'|'html', index: number, length: number}>}
 */
function audioReferences(fieldText) {
  const found = [];
  for (const match of fieldText.matchAll(SOUND_TAG)) {
    found.push({ name: match[1], form: 'sound', index: match.index, length: match[0].length });
  }
  for (const match of fieldText.matchAll(HTML_AUDIO_TAG)) {
    // Anki decodes entities in a media src before it looks the file up, so a
    // name read back here has to be decoded too or it would never match.
    found.push({
      name: decodeEntities(match[1] ?? match[2] ?? match[3] ?? ''),
      form: 'html',
      index: match.index,
      length: match[0].length,
    });
  }
  return found.sort((a, b) => a.index - b.index);
}

function renderAudioReference(filename, form) {
  if (form === 'html') {
    const src = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<audio src="${src}"></audio>`;
  }
  return `[sound:${filename}]`;
}

/**
 * Replace the clip references this tool owns with a single new one in the
 * requested form, leaving any other content of the field - images, the deck
 * author's own recordings, plain text - exactly where it was.
 *
 * Owned references beyond the first are dropped rather than rewritten, so
 * re-running with the other --audio-tag converts a deck instead of leaving it
 * pointing at the same clip twice.
 */
function setOwnedAudio(fieldText, filename, isOwned, form = 'sound') {
  const owned = audioReferences(fieldText).filter((reference) => isOwned(reference.name));
  const tag = filename === null ? '' : renderAudioReference(filename, form);

  if (owned.length === 0) {
    if (tag === '') return fieldText;
    return fieldText.length === 0 ? tag : `${fieldText}${tag}`;
  }

  let out = '';
  let cursor = 0;
  owned.forEach((reference, i) => {
    out += fieldText.slice(cursor, reference.index);
    if (i === 0) out += tag;
    cursor = reference.index + reference.length;
  });
  return out + fieldText.slice(cursor);
}

/**
 * Note types, by id.
 *
 * Schema 11 keeps them as a JSON blob in `col.models`. Schema 18, which is what
 * a modern package carries, keeps them in tables instead, with everything that
 * is not a name or an id in a protobuf blob: `notetypes.config` is a
 * Notetype.Config (proto/anki/notetypes.proto), whose field 2 is the index of
 * the sort field. Both shapes answer the same two questions - what the fields
 * are called, and which of them Anki sorts on.
 *
 * @param {object} pkg  an open package; see lib/package.js openPackage
 */
function readNotetypes(pkg) {
  return pkg.schemaVersion === 11 ? readLegacyNotetypes(pkg.db) : readSchema18Notetypes(pkg.metadataDb);
}

function readLegacyNotetypes(db) {
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

const NOTETYPE_CONFIG_SORT_FIELD_IDX = 2;

function readSchema18Notetypes(db) {
  const notetypes = new Map();
  for (const row of db.prepare('SELECT id, name, config FROM notetypes').all()) {
    notetypes.set(Number(row.id), {
      id: Number(row.id),
      name: row.name,
      sortFieldIndex: sortFieldIndex(Buffer.from(row.config)),
      fieldNames: [],
    });
  }

  // Read whole and sorted here rather than in SQL: the copy these tables are
  // read from has had Anki's collation stripped from its schema, so the order
  // SQLite would return them in is not one to rely on.
  const fields = db.prepare('SELECT ntid, ord, name FROM fields').all();
  fields.sort((a, b) => a.ord - b.ord);
  for (const field of fields) {
    notetypes.get(Number(field.ntid))?.fieldNames.push(field.name);
  }
  return notetypes;
}

function sortFieldIndex(config) {
  for (const field of readFields(config)) {
    if (field.number === NOTETYPE_CONFIG_SORT_FIELD_IDX && field.wireType === WIRE_VARINT) {
      return field.value;
    }
  }
  // proto3 leaves a zero off the wire, and zero is the first field.
  return 0;
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
  AUDIO_TAG_FORMS,
  FIELD_SEPARATOR,
  audioReferences,
  decodeEntities,
  fieldChecksum,
  joinFields,
  readNotetypes,
  renderAudioReference,
  resolveFields,
  setOwnedAudio,
  spokenText,
  splitFields,
  stripHtmlPreservingMedia,
};
