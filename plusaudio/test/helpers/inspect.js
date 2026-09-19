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
      notes,
      cards,
      revlog,
      col,
      mediaMap: pkg.mediaMap,
      mediaNames: new Set(Object.values(pkg.mediaMap)),
      guids: notes.map((n) => n.guid),
      revlogDigest: digest(revlog),
      cardsDigest: digest(cards),
    };
  } finally {
    pkg.db.close();
  }
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
