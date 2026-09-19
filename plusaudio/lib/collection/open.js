'use strict';

// Opening a live collection file, and only that file: no media DB, no package.
//
// See scratchpad investigation "Writing to a live Anki collection from another
// process" (anki-live-write.md in this task's research) for the experiments this
// is built from; the two facts that shape this whole module are:
//
//  - Anki opens collection.anki2 with `locking_mode=exclusive` + WAL and a zero
//    busy timeout (rslib/src/storage/sqlite.rs, open_or_create_collection_db).
//    With no shared-memory wal-index published, a second process cannot even
//    read the file while Anki holds it open; every attempt fails immediately
//    with SQLITE_BUSY ("database is locked"), never blocks, and a timeout does
//    not help because the lock is never released for the connection's lifetime.
//  - The reverse is just as true: if this module leaves a handle open, Anki's
//    own open fails the same way ("Anki already open, or media currently
//    syncing."). So every function in lib/collection/ opens a connection, does
//    one unit of work, and closes it before returning - never a handle held
//    across calls, and never one left open on an error path.
//
// Lock detection is a first-class result here, not a thrown error a caller has
// to pattern-match: openCollection() returns a tagged object, and callers
// switch on `.status` the same way they would check an HTTP status code.

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SUPPORTED_SCHEMAS = new Set([11, 18]);

function isLockedError(error) {
  return /database is locked/i.test(error?.message ?? '');
}

/**
 * Open a collection file, verifying it is actually readable rather than just
 * present. Anki's lock is only observed on a real statement (sqlite3_open
 * itself does not touch the file), so schema_version is read as the trigger,
 * exactly as Anki's own open_or_create does (storage/sqlite.rs, schema_version).
 *
 * @returns one of:
 *   { status: 'not-found', path }
 *   { status: 'locked', path }          Anki (or another process) holds this file open.
 *   { status: 'unsupported-schema', path, schemaVersion }
 *   { status: 'ok', path, schemaVersion, db, close() }
 */
function openCollection(collectionPath) {
  if (!fs.existsSync(collectionPath)) {
    return { status: 'not-found', path: collectionPath };
  }

  let db;
  try {
    db = new DatabaseSync(collectionPath);
  } catch (error) {
    if (isLockedError(error)) return { status: 'locked', path: collectionPath };
    throw error;
  }

  // Zero busy timeout: fail the instant the file is unavailable rather than
  // waiting, matching Anki's own db.busy_timeout(Duration::from_secs(0)).
  // Belt-and-braces alongside the schema_version probe below, which is what
  // actually surfaces SQLITE_BUSY against a real Anki lock.
  try {
    db.exec('PRAGMA busy_timeout = 0');
  } catch (error) {
    db.close();
    if (isLockedError(error)) return { status: 'locked', path: collectionPath };
    throw error;
  }

  let schemaVersion;
  try {
    schemaVersion = db.prepare('SELECT ver FROM col').get().ver;
  } catch (error) {
    db.close();
    if (isLockedError(error)) return { status: 'locked', path: collectionPath };
    throw error;
  }

  if (!SUPPORTED_SCHEMAS.has(schemaVersion)) {
    db.close();
    return { status: 'unsupported-schema', path: collectionPath, schemaVersion };
  }

  // Fold any WAL frames into the main file now, while we already hold the
  // connection. This is what plusaudio/lib/package.js's writePackage does
  // before reading a finished collection back off disk, and it buys us the
  // same thing here: a clean single-file snapshot to copy for the
  // relaxed-collation reads in relaxed-read.js, with no `-wal` sidecar to
  // reason about, and no data movement beyond folding what's already committed.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  return {
    status: 'ok',
    path: collectionPath,
    schemaVersion,
    db,
    close() {
      db.close();
    },
  };
}

/**
 * Open, run one unit of work, and always close - the shape every read and
 * write in this package is built on, so "hold a handle open" is not a thing
 * a caller can even do by accident.
 *
 * `fn` receives the opened handle (status 'ok') and returns a plain value,
 * which is wrapped as `{ status: 'ok', result }`. If open() did not succeed,
 * `fn` is never called and that status is returned unchanged.
 */
function withCollection(collectionPath, fn) {
  const opened = openCollection(collectionPath);
  if (opened.status !== 'ok') return opened;
  try {
    return { status: 'ok', result: fn(opened) };
  } finally {
    opened.close();
  }
}

module.exports = { SUPPORTED_SCHEMAS, isLockedError, openCollection, withCollection };
