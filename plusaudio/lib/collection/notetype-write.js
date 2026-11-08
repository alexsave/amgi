'use strict';

// Creating a note type in a closed collection, by writing the schema-18 rows
// directly.
//
// This is the second of two writers for the same thing, and what each one
// covers is written down here so the next reader does not collapse them:
//
//   - THIS module covers the CLOSED-Anki case. Nothing is running to ask, so
//     the app writes the `notetypes`, `fields` and `templates` rows itself,
//     which is what lets "Install into Anki" finish with the add-card form
//     already usable - no "open Anki once" step.
//   - anki/addon/amgi_bridge/notetype.py covers the OPEN-Anki case and the
//     UPDATE case. With Anki running the collection file is locked and this
//     module cannot touch it; the add-on does the same job through Anki's own
//     Python API at the next profile open, and it is also what refreshes a
//     note type whose templates/css have drifted from the shipped ones, adds
//     missing fields and cleans up media. This module never updates anything:
//     if the name is already taken it does nothing and says so, and leaves
//     drift to the add-on.
//
// The earlier version of this file's neighbours refused to write a note type
// from Node because it meant hard-coding protobuf field numbers "for messages
// this repo has no vendored copy of and cannot validate against". Both halves
// of that are now answered: vendor/anki-src/proto/anki/notetypes.proto is
// vendored (and guarded by vendor-drift.test.js), and
// test/collection/notetype-write.test.js validates every byte against the real
// Anki library - it opens the Node-written collection with it, adds a note,
// generates both cards, runs Check Database, and compares the decoded config
// of this module's note type with the one the add-on makes.
//
// What is written, and where it comes from (notetypes.proto):
//   notetypes.config   Notetype.Config: css(3), latex_pre(5), latex_post(6),
//                      reqs(8), original_stock_kind(9)
//   fields.config      Notetype.Field.Config: font_name(3), font_size(4), id(9)
//   templates.config   Notetype.Template.Config: q_format(1), a_format(2), id(8)
// Everything else is left at its proto3 default, exactly as Anki's own writer
// leaves it (a default is not serialized). The defaults that ARE serialized
// (Arial 20 for fields, the LaTeX preamble, original_stock_kind = Basic) are
// what `col.models.new()` produces, checked against the library by the test.
//
// Schema 11 (col.models JSON, Anki before 2.1.28) is deliberately not handled:
// the add-on needs a modern Anki anyway, so for such a collection this
// reports `created: false, reason: 'legacy-schema'` and the add-on's
// profile-open path remains the way the note type gets made.
//
// The `unicase` collation problem is the same one decks.js and relaxed-read.js
// document: node:sqlite cannot register a collation, so the three tables'
// COLLATE is relaxed to NOCASE for the length of the write and restored. For
// the ASCII-leading names this writes that orders identically to unicase; see
// decks.js for the full argument and for what is and is not guaranteed.

const { writeBytesField, writeVarint, writeVarintField } = require('../protobuf');
const { random } = require('../random');
const { idAllocationExpr } = require('./ids');
const { withCollection } = require('./open');
const { withLiveCollationsRelaxed } = require('./relaxed-read');

// Notetype.Config
const CONFIG_CSS = 3;
const CONFIG_LATEX_PRE = 5;
const CONFIG_LATEX_POST = 6;
const CONFIG_REQS = 8;
const CONFIG_ORIGINAL_STOCK_KIND = 9;
// CardRequirement
const REQ_CARD_ORD = 1;
const REQ_KIND = 2;
const REQ_FIELD_ORDS = 3;
// Field.Config
const FIELD_FONT_NAME = 3;
const FIELD_FONT_SIZE = 4;
const FIELD_ID = 9;
// Template.Config
const TEMPLATE_Q_FORMAT = 1;
const TEMPLATE_A_FORMAT = 2;
const TEMPLATE_ID = 8;

const REQ_KINDS = { none: 0, any: 1, all: 2 };
// StockNotetype.OriginalStockKind.ORIGINAL_STOCK_KIND_BASIC
const ORIGINAL_STOCK_KIND_BASIC = 1;

// rslib/src/notetype/stock.rs, via col.models.new(): the stock Basic note
// type every new note type starts from.
const DEFAULT_FIELD_FONT = 'Arial';
const DEFAULT_FIELD_FONT_SIZE = 20;
const DEFAULT_LATEX_PRE =
  '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n' +
  '\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const DEFAULT_LATEX_POST = '\\end{document}';

const utf8 = (text) => Buffer.from(text, 'utf8');

// The `id` on a field or template is an `optional int64` Anki fills with a
// random value so a rename can be told from a replacement across a sync. It
// only has to be unique and stable, so 48 random bits (a safe JS integer,
// always positive, always a valid int64) is plenty. The draw comes from the
// one seedable source in ../random.js, and is injectable, the same way
// ids.js's randomGuid takes one, so a test can pin it.
function randomId(drawBytes) {
  return drawBytes(6).readUIntBE(0, 6);
}

function packedUint32(values) {
  return Buffer.concat(values.map((v) => writeVarint(v)));
}

function encodeRequirement(req) {
  const kind = REQ_KINDS[req.kind];
  if (kind === undefined) throw new Error(`unknown card requirement kind ${req.kind}`);
  const parts = [];
  if (req.ord) parts.push(writeVarintField(REQ_CARD_ORD, req.ord));
  if (kind) parts.push(writeVarintField(REQ_KIND, kind));
  if (req.fields.length) parts.push(writeBytesField(REQ_FIELD_ORDS, packedUint32(req.fields)));
  return Buffer.concat(parts);
}

/** Notetype.Config, fields in ascending field-number order like Anki's own encoder. */
function encodeNotetypeConfig(spec) {
  return Buffer.concat([
    writeBytesField(CONFIG_CSS, utf8(spec.css)),
    writeBytesField(CONFIG_LATEX_PRE, utf8(spec.latexPre ?? DEFAULT_LATEX_PRE)),
    writeBytesField(CONFIG_LATEX_POST, utf8(spec.latexPost ?? DEFAULT_LATEX_POST)),
    ...(spec.requirements || []).map((req) => writeBytesField(CONFIG_REQS, encodeRequirement(req))),
    writeVarintField(CONFIG_ORIGINAL_STOCK_KIND, ORIGINAL_STOCK_KIND_BASIC),
  ]);
}

function encodeFieldConfig(id) {
  return Buffer.concat([
    writeBytesField(FIELD_FONT_NAME, utf8(DEFAULT_FIELD_FONT)),
    writeVarintField(FIELD_FONT_SIZE, DEFAULT_FIELD_FONT_SIZE),
    writeVarintField(FIELD_ID, id),
  ]);
}

function encodeTemplateConfig(template, id) {
  return Buffer.concat([
    writeBytesField(TEMPLATE_Q_FORMAT, utf8(template.front)),
    writeBytesField(TEMPLATE_A_FORMAT, utf8(template.back)),
    writeVarintField(TEMPLATE_ID, id),
  ]);
}

function validateSpec(spec) {
  if (!spec || typeof spec.name !== 'string' || !spec.name) throw new Error('a note type needs a name');
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) throw new Error('a note type needs fields');
  if (new Set(spec.fields.map((f) => f.toLowerCase())).size !== spec.fields.length) {
    throw new Error('field names must be unique');
  }
  if (!Array.isArray(spec.templates) || spec.templates.length === 0) throw new Error('a note type needs a card template');
  if (typeof spec.css !== 'string') throw new Error('a note type needs css');
}

const NOTETYPE_ID = idAllocationExpr('notetypes');

function createNotetypeSchema18(db, spec, { now, drawBytes }) {
  const taken = db.prepare('SELECT id, name FROM notetypes').all();
  const existing = taken.find((row) => row.name.toLowerCase() === spec.name.toLowerCase());
  if (existing) return { created: false, reason: 'exists', notetypeId: Number(existing.id) };

  const nowMs = now();
  let notetypeId;
  withLiveCollationsRelaxed(db, ['notetypes', 'fields', 'templates'], () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // usn -1 is "pending sync", as for any row Anki itself adds; the id is
      // the epoch millisecond, bumped past a collision (ids.js). Both are
      // checked against what the real library writes by the test.
      notetypeId = Number(
        db
          .prepare(
            `INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (${NOTETYPE_ID}, ?2, ?3, -1, ?4) RETURNING id`,
          )
          .get(nowMs, spec.name, Math.floor(nowMs / 1000), encodeNotetypeConfig(spec)).id,
      );
      const insertField = db.prepare('INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)');
      spec.fields.forEach((name, ord) => {
        insertField.run(notetypeId, ord, name, encodeFieldConfig(randomId(drawBytes)));
      });
      // Templates carry their own mtime/usn columns, and Anki writes both 0
      // for a template created with its note type.
      const insertTemplate = db.prepare(
        'INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, 0, ?)',
      );
      spec.templates.forEach((template, ord) => {
        insertTemplate.run(notetypeId, ord, template.name, encodeTemplateConfig(template, randomId(drawBytes)));
      });
      db.prepare('UPDATE col SET mod = ? WHERE id = 1').run(nowMs);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return { created: true, notetypeId };
}

/**
 * Create `spec` as a note type in the collection at `collectionPath`, unless
 * one with that name (case-insensitively, like unicase) already exists.
 *
 * @param {string} collectionPath
 * @param {{
 *   name: string,
 *   fields: string[],
 *   templates: {name: string, front: string, back: string}[],
 *   css: string,
 *   requirements?: {ord: number, kind: 'none'|'any'|'all', fields: number[]}[],
 *   latexPre?: string, latexPost?: string,
 * }} spec  `requirements` is Anki's legacy per-card "which fields must be
 *   non-empty" list. Modern Anki recomputes what it needs from the templates,
 *   but it is still written, because the add-on's note type has it and an old
 *   client or an export reads it.
 * @returns {{status: string, result?: {created: boolean, notetypeId?: number, reason?: string}}}
 */
function createNotetype(collectionPath, spec, { now = Date.now, drawBytes = (count) => random.bytes(count) } = {}) {
  validateSpec(spec);
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    if (schemaVersion === 11) return { created: false, reason: 'legacy-schema' };
    return createNotetypeSchema18(db, spec, { now, drawBytes });
  });
}

module.exports = { DEFAULT_LATEX_POST, DEFAULT_LATEX_PRE, createNotetype, encodeNotetypeConfig };
