'use strict';

// Reading note types with their fields and card templates - the input
// template.js needs to work out which cards a new note requires, and what
// resolveFields-style callers need to place field text correctly.
//
// This overlaps with plusaudio/lib/deck.js's readNotetypes, but that function
// only reads what plusaudio itself needs (field names and the sort field) and
// deliberately leaves out templates and note type kind, since plusaudio never
// creates a note or a card. Card creation needs both, so this module reads
// notetypes itself rather than extending deck.js's narrower shape; the two
// still share protobuf.js's wire reader and the schema-11-vs-18 dispatch
// pattern package.js established.

const { WIRE_LENGTH, WIRE_VARINT, readFieldsLenient } = require('../protobuf');
const { withRelaxedCollations } = require('./relaxed-read');

/**
 * @typedef {object} Notetype
 * @property {number} id
 * @property {string} name
 * @property {'normal'|'cloze'} kind
 * @property {number} sortFieldIndex
 * @property {string[]} fieldNames
 * @property {{ord: number, name: string, questionFormat: string}[]} templates
 */

function readLegacyNotetypes(db) {
  const models = JSON.parse(db.prepare('SELECT models FROM col').get().models);
  const notetypes = new Map();
  for (const [id, model] of Object.entries(models)) {
    notetypes.set(Number(id), {
      id: Number(id),
      name: model.name,
      // schema11.rs: 0 = Normal, 1 = Cloze (col.models[*].type).
      kind: model.type === 1 ? 'cloze' : 'normal',
      sortFieldIndex: model.sortf ?? 0,
      fieldNames: [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: [...model.tmpls]
        .sort((a, b) => a.ord - b.ord)
        .map((t) => ({ ord: t.ord, name: t.name, questionFormat: t.qfmt })),
    });
  }
  return notetypes;
}

// Notetype.Config field numbers (vendor/anki-src/proto/anki/notetypes.proto).
const NOTETYPE_CONFIG_KIND = 1;
const NOTETYPE_CONFIG_SORT_FIELD_IDX = 2;
// Notetype.Template.Config field numbers (same file).
const TEMPLATE_CONFIG_QUESTION_FORMAT = 1;

// Notetype.Config has other varint fields we don't read (target_deck_id_unused,
// original_stock_kind) and an optional 64-bit original_id that real imported
// notetypes do carry - readFieldsLenient skips any varint field number not
// listed here rather than decoding it, so that field never has to fit in a
// JS number (see protobuf.js).
const NOTETYPE_CONFIG_WANTED_VARINTS = new Set([NOTETYPE_CONFIG_KIND, NOTETYPE_CONFIG_SORT_FIELD_IDX]);

function readNotetypeConfig(configBytes) {
  let kind = 'normal';
  let sortFieldIndex = 0;
  for (const field of readFieldsLenient(configBytes, NOTETYPE_CONFIG_WANTED_VARINTS)) {
    if (field.number === NOTETYPE_CONFIG_KIND && field.wireType === WIRE_VARINT) {
      kind = field.value === 1 ? 'cloze' : 'normal';
    } else if (field.number === NOTETYPE_CONFIG_SORT_FIELD_IDX && field.wireType === WIRE_VARINT) {
      sortFieldIndex = field.value;
    }
  }
  return { kind, sortFieldIndex };
}

// Template.Config's `id` (field 8) is a real random 64-bit value on any
// template that came from an imported notetype (Anki 23.10+) - verified
// against the installed Anki library, whose own freshly-created "Basic"
// templates already carry one. We want no varint field here at all, only the
// question format string (field 1, length-delimited), so the wanted set is
// empty and every varint in this message is skipped unread.
const TEMPLATE_CONFIG_WANTED_VARINTS = new Set();

function readTemplateConfig(configBytes) {
  let questionFormat = '';
  for (const field of readFieldsLenient(configBytes, TEMPLATE_CONFIG_WANTED_VARINTS)) {
    if (field.number === TEMPLATE_CONFIG_QUESTION_FORMAT && field.wireType === WIRE_LENGTH) {
      questionFormat = field.bytes.toString('utf8');
    }
  }
  return questionFormat;
}

function readSchema18Notetypes(metadataDb) {
  const notetypes = new Map();
  for (const row of metadataDb.prepare('SELECT id, name, config FROM notetypes').all()) {
    const { kind, sortFieldIndex } = readNotetypeConfig(Buffer.from(row.config));
    notetypes.set(Number(row.id), {
      id: Number(row.id),
      name: row.name,
      kind,
      sortFieldIndex,
      fieldNames: [],
      templates: [],
    });
  }

  // Read whole and sort in JS, same reasoning as deck.js: the copy these
  // tables are read from has had Anki's collation stripped out of its schema,
  // so SQL's own ORDER BY on these tables is not trustworthy.
  const fields = metadataDb.prepare('SELECT ntid, ord, name FROM fields').all();
  fields.sort((a, b) => a.ord - b.ord);
  for (const field of fields) {
    notetypes.get(Number(field.ntid))?.fieldNames.push(field.name);
  }

  const templates = metadataDb.prepare('SELECT ntid, ord, name, config FROM templates').all();
  templates.sort((a, b) => a.ord - b.ord);
  for (const template of templates) {
    const notetype = notetypes.get(Number(template.ntid));
    if (!notetype) continue;
    notetype.templates.push({
      ord: template.ord,
      name: template.name,
      questionFormat: readTemplateConfig(Buffer.from(template.config)),
    });
  }

  return notetypes;
}

/**
 * Every note type in the collection, keyed by id.
 *
 * @param {import('node:sqlite').DatabaseSync} db  the live collection handle
 * @param {number} schemaVersion
 * @param {string} collectionPath  needed only for schema 18, to build the
 *   relaxed-collation copy fields/templates require (see relaxed-read.js)
 * @returns {Map<number, Notetype>}
 */
function readNotetypes(db, schemaVersion, collectionPath) {
  if (schemaVersion === 11) return readLegacyNotetypes(db);
  return withRelaxedCollations(collectionPath, readSchema18Notetypes);
}

module.exports = { readNotetypes };
