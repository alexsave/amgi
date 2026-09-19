'use strict';

// Reading schema 18's notetypes/fields/templates/decks tables, which
// node:sqlite cannot open at all without help.
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
// Anki 26.09.2 library's own collections).
//
// The fix, already used for the same reason in plusaudio/lib/package.js
// (openWithRelaxedCollations), is to read from a throwaway copy with the
// collation keyword stripped out of the copy's own sqlite_master text via
// `PRAGMA writable_schema`. That trades "correct collation" for "binary
// comparison", which is only safe because every read this module does
// against the copy is either a full table scan or a WHERE/JOIN on a
// non-collated column (ntid, ord, id) - never an ORDER BY or WHERE on the
// collated name column itself, so the substitution is never observed.
//
// This module does not reuse package.js's function directly: that one names
// the copy `${collectionPath}-metadata`, which is fine for a package.js caller
// that unpacked the .apkg into its own throwaway directory, but wrong here -
// this collectionPath is the user's real, live collection file, and dropping
// a sibling file next to it (with no guaranteed cleanup on every exit path,
// and a name that could collide across concurrent runs) is exactly the kind of
// mess this module exists to avoid. So the copy goes into a proper temp
// directory instead, cleaned up in a finally block.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Copy `collectionPath` into a temp directory, strip `COLLATE unicase` from
 * its schema, hand the copy to `fn`, then delete the whole temp directory.
 *
 * The copy is read-only in spirit (never written back), so no data written
 * through it can leak into the real collection; only the schema text of the
 * copy is mutated, and only to make it openable at all.
 */
function withRelaxedCollations(collectionPath, fn) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-collection-relaxed-'));
  const copyPath = path.join(workDir, 'collection.anki2');
  let db;
  try {
    fs.copyFileSync(collectionPath, copyPath);
    db = new DatabaseSync(copyPath);
    // node:sqlite turns on SQLite's "defensive" mode by default, which exists
    // specifically to forbid writing to sqlite_master; this is the one place
    // in this package where that has to be turned off.
    db.enableDefensive(false);
    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '')");
    db.exec('PRAGMA writable_schema = RESET');
    return fn(db);
  } finally {
    if (db) db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { withRelaxedCollations };
