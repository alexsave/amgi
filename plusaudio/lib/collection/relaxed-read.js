'use strict';

// Reading schema 18's `fields`/`templates` tables, which node:sqlite cannot
// even plan a SELECT against without help.
//
// Schema 18 declares `COLLATE unicase` on the name columns of notetypes,
// fields, templates, decks and tags (rslib/src/storage/sqlite.rs registers a
// custom "unicase" collation via `db.create_collation`, backed by the
// `unicase` crate - see decks.js for a longer discussion of exactly what that
// collation does and why writes are harder than reads). node:sqlite has no API
// to register a collation of its own, and SQLite refuses to plan *any*
// statement against a table that needs a collation it cannot resolve. For
// `fields` and `templates` specifically - WITHOUT ROWID tables whose primary
// key is (ntid, ord), not the collated column - this is not merely "sorting is
// wrong", it is "the table cannot be opened at all": a plain `SELECT * FROM
// fields` fails with "no query solution" (verified against the installed
// Anki 26.09.2 library's own collections, and against node:sqlite directly -
// see notetypes.js's test coverage). `notetypes` and `decks` are ordinary
// ROWID tables and never hit this at all; only the two WITHOUT ROWID tables
// need this module.
//
// The fix is to relax the collation, do the read, and restore it - all on the
// *live, already-open* collection handle, via `PRAGMA writable_schema`. This
// is exactly decks.js's `withDecksCollationRelaxed` technique (see that
// module's comment for the full "why is this safe" reasoning, since it
// already does this on the live file for a write), generalized here to any
// list of tables and to a plain read.
//
// An earlier version of this module instead copied the whole collection file
// into a throwaway temp directory and relaxed the copy's schema, which was
// simpler to reason about but meant every single call - including
// readNotetypes on the hot addNote/updateNoteFields path - paid for a full
// `fs.copyFileSync` of the user's entire collection. Measured against a
// collection of a few megabytes, that was over 10ms of pure copy overhead per
// note added, scaling with the collection's own size rather than the size of
// whatever batch was being written - so a bulk paste of a few thousand lines
// into a real (not toy) collection cost tens of seconds just in file copies,
// before a single byte of the actual notes was written. Relaxing the live
// handle's schema in place removes that copy entirely: relaxing and restoring
// `fields`/`templates`' name-column collation touches nothing SQLite uses to
// look rows up (their primary key is the uncollated `(ntid, ord)`), only what
// it would need to ORDER BY or compare that column - neither of which any
// caller here does; every ordering is done in JS afterwards, on the plain
// integer `ord` column.

/**
 * Run `fn(db)` with `COLLATE unicase` temporarily stripped from `tableNames`'
 * own schema text, restoring it before returning (even if `fn` throws).
 */
function withLiveCollationsRelaxed(db, tableNames, fn) {
  const placeholders = tableNames.map(() => '?').join(',');
  const originals = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (${placeholders})`)
    .all(...tableNames);

  // node:sqlite turns on SQLite's "defensive" mode by default, which exists
  // specifically to forbid writing to sqlite_master; this is the one place in
  // this package (alongside decks.js's own copy of this dance) where that has
  // to be turned off, and only for the duration of this call.
  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema = ON');
  const relax = db.prepare("UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '') WHERE name = ?");
  for (const { name } of originals) relax.run(name);
  db.exec('PRAGMA writable_schema = RESET');
  try {
    return fn(db);
  } finally {
    db.exec('PRAGMA writable_schema = ON');
    const restore = db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?');
    for (const { name, sql } of originals) restore.run(sql, name);
    db.exec('PRAGMA writable_schema = RESET');
  }
}

module.exports = { withLiveCollationsRelaxed };
