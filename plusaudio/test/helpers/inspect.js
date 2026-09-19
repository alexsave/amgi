'use strict';

const crypto = require('node:crypto');
const { openPackage } = require('../../lib/package');

/** Everything the identity tests need to compare two packages. */
function inspectPackage(filePath) {
  const pkg = openPackage(filePath);
  try {
    const notes = pkg.db.prepare('SELECT id, guid, mid, mod, usn, flds, sfld, csum FROM notes ORDER BY id').all();
    const cards = pkg.db.prepare('SELECT * FROM cards ORDER BY id').all();
    const revlog = pkg.db.prepare('SELECT * FROM revlog ORDER BY id').all();
    const col = pkg.db.prepare('SELECT crt, scm, ver, decks, models FROM col').get();
    return {
      format: pkg.format,
      schemaVersion: pkg.schemaVersion,
      notes,
      cards,
      revlog,
      col,
      decks: decks(pkg),
      notetypes: notetypes(pkg),
      mediaMap: pkg.mediaMap,
      mediaNames: new Set(Object.values(pkg.mediaMap)),
      guids: notes.map((n) => n.guid),
      revlogDigest: digest(revlog),
      cardsDigest: digest(cards),
    };
  } finally {
    pkg.close();
  }
}

/**
 * Deck ids and names, whichever schema the collection is in: 11 keeps them in a
 * JSON blob in `col`, 18 in a table of their own.
 */
function decks(pkg) {
  if (pkg.schemaVersion === 11) {
    const blob = JSON.parse(pkg.db.prepare('SELECT decks FROM col').get().decks);
    return Object.values(blob)
      .map((deck) => `${deck.id}:${deck.name}`)
      .sort();
  }
  return pkg.metadataDb
    .prepare('SELECT id, name FROM decks')
    .all()
    .map((deck) => `${deck.id}:${deck.name}`)
    .sort();
}

function notetypes(pkg) {
  if (pkg.schemaVersion === 11) {
    const blob = JSON.parse(pkg.db.prepare('SELECT models FROM col').get().models);
    return Object.values(blob)
      .map((model) => `${model.id}:${model.name}:${model.flds.map((f) => f.name).join(',')}`)
      .sort();
  }
  const fields = new Map();
  for (const field of pkg.metadataDb.prepare('SELECT ntid, ord, name FROM fields').all()) {
    if (!fields.has(String(field.ntid))) fields.set(String(field.ntid), []);
    fields.get(String(field.ntid)).push(field);
  }
  return pkg.metadataDb
    .prepare('SELECT id, name FROM notetypes')
    .all()
    .map((notetype) => {
      const names = (fields.get(String(notetype.id)) ?? [])
        .sort((a, b) => a.ord - b.ord)
        .map((f) => f.name)
        .join(',');
      return `${notetype.id}:${notetype.name}:${names}`;
    })
    .sort();
}

function digest(rows) {
  const canonical = rows.map((row) =>
    Object.keys(row)
      .sort()
      .map((key) => `${key}=${row[key]}`)
      .join('|'),
  );
  return crypto.createHash('sha256').update(canonical.join('\n'), 'utf8').digest('hex');
}

module.exports = { digest, inspectPackage };
