'use strict';

// A copy of the collection file, taken before this tool changes anything.
//
// Anki keeps its own rolling backups (qt/aqt/main.py, a throttled backup every
// 5 minutes and one on profile close, rslib/src/collection/backup.rs), but
// those only run while Anki itself is open. Every write this package makes
// happens while Anki is closed, so nothing else is watching - a tool that
// edits someone's collection directly and has no backup of its own is one bug
// away from being the only copy of a mistake.
//
// The cost of that is a full file copy, which scales with the collection, not
// with the edit: ~27ms for a one-note write on an 18MB collection, of which
// ~2.5ms is the actual write. So the question this module answers is not
// "should we back up" (yes, always, before touching anything) but "is the
// backup we already have still the one this change needs".
//
// WHY THE POLICY LIVES HERE, KEYED BY PATH
//
// It used to live on the Collection instance (index.js: one `_backedUp` flag
// per object), on the assumption that one instance meant one working session.
// That assumption was false for the app: src/server/anki/transport.js builds a
// fresh Collection per HTTP request, so the "session" was one request long and
// every mutating request re-copied the whole collection file - 45 copies for
// 45 note adds, and nothing ever deleted them. Two fixes were considered:
//
//  - Cache the Collection (or its flag) per path in the direct transport.
//    Rejected: it turns "once per session" into "once per server process",
//    and this server is long-lived - a dev server or a background app running
//    for a week would take exactly one backup, on the day it started. Worse,
//    it cannot see Anki editing the collection in between, which is the one
//    external change a backup most needs to sit in front of. It would also
//    fix only the one caller, leaving the same trap for every other consumer
//    of this package.
//  - Keep the decision here, in a ledger keyed by the collection path. Chosen.
//    Callers stay free to build Collection objects whenever they like, and
//    the policy is the same for all of them.
//
// THE GUARANTEE, AFTER THE CHANGE
//
// Before this package modifies a collection, a backup exists that was taken
// (a) after the last change anyone else made to that file, and (b) no more
// than BACKUP_MAX_AGE_MS of this package's own editing ago. Concretely, a
// backup is taken before a mutation whenever any of these is true:
//
//   1. this process has not backed up this path yet - a fresh start, or the
//      user switching profiles, both of which mean we know nothing;
//   2. the collection does not look the way we left it, so somebody else
//      (Anki, a sync, a restore, a second amgi process) has written to it;
//   3. our last backup is older than BACKUP_MAX_AGE_MS.
//
// Rule 2 is the important one: no external change is ever unbacked-up when we
// start editing on top of it. Rule 3 bounds what a restore can cost when it
// is our own writes stacking up - without it, a long run of edits would all
// sit behind a single morning backup. Every way the ledger can be wrong -
// state lost on restart, a path spelled differently, a mutation that skipped
// this module - makes it take an *extra* backup, never skip one.
//
// What is deliberately NOT promised: a backup per mutation. Undoing one bad
// note out of a batch is not what this is for; surviving a bug that mangles
// the file is.

const fs = require('node:fs');
const path = require('node:path');

const { openCollection } = require('./open');

const BACKUP_DIRNAME = 'amgi-collection-backups';

// 30 minutes. Anki's own live throttle is 5 minutes, but it is babysitting a
// running session continuously; our writes are user-initiated bursts, and the
// boundary that actually matters (someone else touched the file) is detected
// exactly rather than guessed at by a timer. 30 minutes caps the amount of
// amgi-only work a restore can cost at something a person can redo, while
// keeping a heavy bulk-import session to a couple of copies instead of one per
// note.
const BACKUP_MAX_AGE_MS = 30 * 60 * 1000;

// Keep the ten most recent backups of a given collection, delete the rest.
// Count, not age: age-based retention deletes a returning user's only safety
// net precisely because they were away, and byte-based retention needs the
// same sort anyway while still not bounding how many files pile up. Ten is
// bounded disk (ten times the collection, so ~190MB for the 18MB collection
// above) and a long-enough tail to reach back past several working periods.
const BACKUP_KEEP_COUNT = 10;

// The name backupCollectionFile() writes, and the ONLY name pruning will ever
// delete: `<collection basename>.<ISO timestamp, : and . replaced by ->.bak`.
// Matched strictly, and the timestamp is round-tripped through Date below, so
// anything a user (or another tool) put in this folder is left alone.
const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/**
 * Per-collection-path record of what this process has already done:
 *   backedUpAt - when we last copied this collection.
 *   mark       - how the collection looked right after our last write, so the
 *                next mutation can tell "nobody has touched it since" from
 *                "somebody has".
 *
 * Keyed by the resolved path, so two profiles (or a test's temp collection and
 * the real one) can never read each other's entry, and one entry per profile
 * the user actually opens is all this ever holds.
 */
const ledger = new Map();

function ledgerKey(collectionPath) {
  return path.resolve(collectionPath);
}

/**
 * A fingerprint of the collection's *logical* state: Anki's own col.mod (the
 * collection modification time every writer bumps - see notes.js and decks.js
 * for our own `UPDATE col SET mod = ?`, and rslib's usn/mod bookkeeping for
 * Anki's), plus the schema-modified time, the schema version, and the file's
 * inode so that swapping a different file into place is caught even if its
 * mod happens to match.
 *
 * It is read out of the database rather than off the filesystem because the
 * filesystem lies here, in both directions, as measured on a real collection:
 *
 *  - mtime moves when nobody changed anything. The first open after one of our
 *    writes checkpoints leftover WAL frames into the main file (open.js does
 *    `wal_checkpoint(TRUNCATE)` on every open), so a plain read - the status
 *    poll the UI runs on a timer, say - bumps mtime and would look exactly
 *    like Anki having edited the collection. With a per-request transport that
 *    puts us straight back to copying the file on every mutating request.
 *  - SQLite's own file change counter (header bytes 24-27) does not move when
 *    somebody did: Anki leaves the collection in WAL mode, and in WAL mode
 *    that counter simply is not maintained. Measured: it stayed at 2 across
 *    writes from both this package and Anki itself.
 *
 * `db` is an already-open handle when the caller has one (index.js's lock
 * probe), otherwise this opens and closes its own, which costs ~0.5ms and does
 * not scale with the collection's size.
 *
 * @returns a comparable string, or null if the collection cannot be read at
 * all (Anki holds the lock, the file is gone) - which reads as "unknown".
 */
function readCollectionMark(collectionPath, db = null) {
  const readFrom = (handle) => {
    const row = handle.prepare('SELECT mod, scm, ver FROM col WHERE id = 1').get();
    if (!row) return null;
    const { ino } = fs.statSync(collectionPath);
    return `${ino}:${row.mod}:${row.scm}:${row.ver}`;
  };

  try {
    if (db) return readFrom(db);
    const opened = openCollection(collectionPath);
    if (opened.status !== 'ok') return null;
    try {
      return readFrom(opened.db);
    } finally {
      opened.close();
    }
  } catch {
    return null;
  }
}

/** The folder backups for `collectionPath` live in - a sibling of the collection itself. */
function backupDirFor(collectionPath) {
  return path.join(path.dirname(collectionPath), BACKUP_DIRNAME);
}

/** The ms since epoch a backup filename's stamp encodes, or null if it is not one of ours. */
function parseStamp(stamp) {
  const match = STAMP_PATTERN.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
  const value = Date.parse(iso);
  // Rejects the calendar-shaped-but-impossible (month 13, 31 February): Date
  // rolls those over, so a round trip that does not come back identical means
  // this file was never one we wrote.
  if (Number.isNaN(value) || new Date(value).toISOString() !== iso) return null;
  return value;
}

/**
 * Every file in the backup folder that this module is certain it wrote for
 * `collectionPath`, newest first.
 *
 * Deliberately paranoid: this list is what pruning deletes from, and it points
 * into the user's Anki data folder. A name only qualifies if it is a regular
 * file (not a directory, not a symlink), begins with exactly this collection's
 * basename, ends in `.bak`, and has a timestamp between them that round-trips
 * through Date - so `collection.anki2.bak`, `collection.anki2.2026-13-45T...`,
 * a hand-renamed `keep-this-collection.anki2....bak` and anything else are all
 * invisible here.
 */
function listBackups(collectionPath) {
  const dir = backupDirFor(collectionPath);
  const prefix = `${path.basename(collectionPath)}.`;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
    const takenAt = parseStamp(name.slice(prefix.length, name.length - '.bak'.length));
    if (takenAt === null) continue;
    found.push({ name, path: path.join(dir, name), takenAt });
  }
  // Newest first, by the timestamp in the name rather than by mtime: the name
  // is when the backup was taken, and copying or restoring the folder rewrites
  // mtimes without rewriting names.
  found.sort((a, b) => b.takenAt - a.takenAt || b.name.localeCompare(a.name));
  return found;
}

/**
 * Delete all but the BACKUP_KEEP_COUNT newest backups of `collectionPath`.
 *
 * Never touches the most recent one (keep count is forced to at least 1 and
 * the list is sorted newest first), never touches a file listBackups() did not
 * vouch for, and never throws: a backup that exists but could not be tidied up
 * after is a strictly better outcome than a failed write, so an unlink we are
 * not allowed to do is simply left for next time.
 *
 * @returns the paths actually deleted.
 */
function pruneBackups(collectionPath, { keep = BACKUP_KEEP_COUNT } = {}) {
  const backups = listBackups(collectionPath);
  const deleted = [];
  for (const backup of backups.slice(Math.max(keep, 1))) {
    try {
      fs.unlinkSync(backup.path);
      deleted.push(backup.path);
    } catch {
      // Gone already, or not ours to remove. Either way, nothing to do.
    }
  }
  return deleted;
}

/**
 * Copy `collectionPath` into a sibling `amgi-collection-backups/` folder,
 * timestamped so repeated runs never overwrite an earlier backup, then prune
 * the folder back to BACKUP_KEEP_COUNT. Unconditional - callers that want the
 * once-per-working-period policy call ensureBackupBeforeChange().
 *
 * The name is claimed with COPYFILE_EXCL and the timestamp walked forward a
 * millisecond at a time until one is free. A plain copy to a name built from
 * Date.now() looks unique but is not: two backups taken inside the same
 * millisecond - easy on a small collection, and the first thing a test that
 * backs up twice in a row does - silently overwrite each other, which in a
 * backup module means the earlier state is gone. Walking the stamp keeps every
 * name parseable by the same pattern pruning trusts, rather than inventing a
 * `-2` suffix pruning would then have to learn.
 *
 * @returns the path the backup was written to.
 */
function backupCollectionFile(collectionPath) {
  const dir = backupDirFor(collectionPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(collectionPath);
  const startedAt = Date.now();
  for (let offsetMs = 0; offsetMs < 1000; offsetMs += 1) {
    const stamp = new Date(startedAt + offsetMs).toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.${stamp}.bak`);
    try {
      fs.copyFileSync(collectionPath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    pruneBackups(collectionPath);
    return backupPath;
  }
  throw new Error(`could not find a free backup name for ${collectionPath} in ${dir}`);
}

/**
 * Take a backup if the collection needs one before being changed - see this
 * module's header for the three cases and the guarantee they add up to.
 *
 * Call this immediately before a mutation, and noteCollectionWritten() after
 * it. `now` and `mark` are injectable: `mark` so a caller that already has the
 * collection open can spend one open instead of two, `now` so tests can age a
 * backup without sleeping.
 *
 * @returns the backup path if one was taken, otherwise null.
 */
function ensureBackupBeforeChange(collectionPath, { now = Date.now(), mark = readCollectionMark(collectionPath) } = {}) {
  const key = ledgerKey(collectionPath);
  const record = ledger.get(key);

  if (record && now - record.backedUpAt < BACKUP_MAX_AGE_MS) {
    // An unreadable collection means Anki has it open. Copying it now would
    // produce the torn, WAL-inconsistent file Anki's own manual warns about -
    // not a backup at all - and there is a recent one already. Only addMedia
    // can reach here in that state, and dropping a clip into collection.media/
    // cannot damage the database anyway (see index.js).
    if (mark === null) return null;
    if (mark === record.mark) return null;
  }

  const backupPath = backupCollectionFile(collectionPath);
  // Record the mark as of the backup, not just the time: if the caller never
  // gets as far as writing (a mutation that throws, say), the next call still
  // sees an unchanged collection and does not copy it again.
  ledger.set(key, { backedUpAt: now, mark });
  return backupPath;
}

/**
 * Remember how the collection looks now that we have finished writing to it,
 * so the next mutation can tell our own edit apart from somebody else's.
 *
 * Costs one open (~0.5ms, flat in the collection's size) against a copy that
 * is ~27ms and climbing on an 18MB collection. Skipping it is not a
 * correctness problem - the next mutation just sees an unrecognised
 * collection and takes an extra backup.
 */
function noteCollectionWritten(collectionPath, { mark = readCollectionMark(collectionPath) } = {}) {
  const record = ledger.get(ledgerKey(collectionPath));
  if (!record) return;
  record.mark = mark;
}

/** Forget everything this process remembers - tests only, so one test's temp collection cannot age into another's. */
function resetBackupLedger() {
  ledger.clear();
}

module.exports = {
  BACKUP_DIRNAME,
  BACKUP_KEEP_COUNT,
  BACKUP_MAX_AGE_MS,
  backupCollectionFile,
  backupDirFor,
  ensureBackupBeforeChange,
  listBackups,
  noteCollectionWritten,
  pruneBackups,
  readCollectionMark,
  resetBackupLedger,
};
