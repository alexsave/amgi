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
const { withLiveCollationsRelaxed } = require('./relaxed-read');

/**
 * @typedef {object} Notetype
 * @property {number} id
 * @property {string} name
 * @property {'normal'|'cloze'} kind
 * @property {number} sortFieldIndex
 * @property {string[]} fieldNames
 * @property {{ord: number, name: string, questionFormat: string, answerFormat: string}[]} templates
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
        .map((t) => ({ ord: t.ord, name: t.name, questionFormat: t.qfmt, answerFormat: t.afmt })),
    });
  }
  return notetypes;
}

// Notetype.Config field numbers (vendor/anki-src/proto/anki/notetypes.proto).
const NOTETYPE_CONFIG_KIND = 1;
const NOTETYPE_CONFIG_SORT_FIELD_IDX = 2;
// Notetype.Template.Config field numbers (same file).
const TEMPLATE_CONFIG_QUESTION_FORMAT = 1;
// Field 2, confirmed by decoding a real collection written by Anki 26.09.2
// rather than read off a .proto: the blob held field 1 == the front template
// file byte for byte and field 2 == the back template file, with only the
// random `id` varint beside them.
const TEMPLATE_CONFIG_ANSWER_FORMAT = 2;

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
// two format strings (fields 1 and 2, length-delimited), so the wanted set
// is empty and every varint in this message is skipped unread.
const TEMPLATE_CONFIG_WANTED_VARINTS = new Set();

function readTemplateConfig(configBytes) {
  let questionFormat = '';
  let answerFormat = '';
  for (const field of readFieldsLenient(configBytes, TEMPLATE_CONFIG_WANTED_VARINTS)) {
    if (field.wireType !== WIRE_LENGTH) continue;
    if (field.number === TEMPLATE_CONFIG_QUESTION_FORMAT) questionFormat = field.bytes.toString('utf8');
    else if (field.number === TEMPLATE_CONFIG_ANSWER_FORMAT) answerFormat = field.bytes.toString('utf8');
  }
  return { questionFormat, answerFormat };
}

// `notetypes` is an ordinary ROWID table keyed by id - unlike `fields` and
// `templates` below, its `name COLLATE unicase` column never stops a plain
// SELECT from planning (verified against the installed Anki 26.09.2
// library), so this reads it straight off the live handle with no collation
// relaxation needed at all.
function readSchema18NotetypesTable(db) {
  const notetypes = new Map();
  for (const row of db.prepare('SELECT id, name, config FROM notetypes').all()) {
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
  return notetypes;
}

// `fields` and `templates`, by contrast, are WITHOUT ROWID tables (see
// relaxed-read.js's module comment) that node:sqlite cannot even plan a
// SELECT against until COLLATE unicase is relaxed - hence
// withLiveCollationsRelaxed around this one.
function readFieldsAndTemplates(db, notetypes) {
  // Read whole and sort by `ord` (a plain integer column, no collation
  // involved) in JS rather than SQL: this only matters while the schema's
  // collation is relaxed, so an ORDER BY name would not be trustworthy here,
  // but ord never needed the collation to sort correctly in the first place -
  // this is just being consistent with decks.js's own caution on this point.
  const fields = db.prepare('SELECT ntid, ord, name FROM fields').all();
  fields.sort((a, b) => a.ord - b.ord);
  for (const field of fields) {
    notetypes.get(Number(field.ntid))?.fieldNames.push(field.name);
  }

  const templates = db.prepare('SELECT ntid, ord, name, config FROM templates').all();
  templates.sort((a, b) => a.ord - b.ord);
  for (const template of templates) {
    const notetype = notetypes.get(Number(template.ntid));
    if (!notetype) continue;
    notetype.templates.push({
      ord: template.ord,
      name: template.name,
      ...readTemplateConfig(Buffer.from(template.config)),
    });
  }
}

/**
 * Every note type in the collection, keyed by id.
 *
 * @param {import('node:sqlite').DatabaseSync} db  the live collection handle
 * @param {number} schemaVersion
 * @returns {Map<number, Notetype>}
 */
function readNotetypes(db, schemaVersion) {
  if (schemaVersion === 11) return readLegacyNotetypes(db);
  const notetypes = readSchema18NotetypesTable(db);
  withLiveCollationsRelaxed(db, ['fields', 'templates'], () => readFieldsAndTemplates(db, notetypes));
  return notetypes;
}

module.exports = { readNotetypes };
