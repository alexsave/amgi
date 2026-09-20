'use strict';

// Listing and creating decks, in both collection schemas.
//
// Schema 11 keeps every deck as an entry in a single JSON object stored in
// col.decks (vendor/anki-src/rslib/src/storage/schema11.sql, the `decks`
// column of `col`). There is no index, so there is nothing special to get
// right here beyond matching the JSON shape Anki itself writes (verified
// against a real collection - see the field list in newDeckJson below) and
// keying the object by the deck's id, in decimal, as a *string* (JSON object
// keys are always strings; Anki's own Rust code re-parses them with
// `.parse().unwrap()` when it loads this blob, ints/schema11.rs).
//
// Schema 18 keeps decks in a `decks` table (id, name, mtime_secs, usn, common,
// kind - vendor/anki-src/proto/anki/decks.proto, message Deck) with a UNIQUE
// INDEX on name, and name's column type declares `COLLATE unicase`
// (rslib/src/storage/sqlite.rs registers "unicase" via `db.create_collation`,
// backed by the `unicase` crate pinned in Cargo.toml with the comment "any
// changes could invalidate sqlite indexes" - the maintainers' own words for
// how load-bearing this collation's exact behaviour is).
//
// That collation is genuinely full Unicode case folding, not ASCII-only:
// verified against the installed Anki 26.09.2 library, "café"/"CAFÉ" and even
// "straße"/"STRASSE" (the German ß -> ss expansion, which a simple
// per-character lower-case never produces) are treated as the same deck name.
// node:sqlite has no API to register a custom collation, only scalar
// functions (db.function()), which SQLite cannot use for index ordering. That
// leaves two things this module cannot do with full fidelity to the real
// unicase collation, and both are called out here rather than papered over:
//
//  1. Duplicate detection (does a deck with this name already exist?) is done
//     in JS with `foldKey`, which folds ASCII case exactly like Anki - the
//     realistic case for a Korean/English deck name - but does not replicate
//     Unicode's multi-character special foldings (ß, ligatures, Turkish
//     dotted/dotless i). A name that only collides with an existing one
//     through one of those foldings will be treated as new. This is a
//     narrower miss than it sounds: it is symmetric with what a plain
//     `SELECT name FROM decks` can even see (see relaxed-read.js for the
//     schema-18 read side of this), and it never produces a wrong write -
//     worst case, a second deck gets created where Anki's own UI would have
//     reused one.
//  2. Writing a new row into the schema-18 `decks` table needs SQLite to
//     maintain that UNIQUE INDEX, which needs the real collation. Since we
//     cannot supply it, the write strips `COLLATE unicase` from the table's
//     schema text (the same `PRAGMA writable_schema` trick relaxed-read.js
//     uses for reads, but here applied to the live file, scoped tightly, and
//     restored before the connection closes), inserts under plain binary
//     comparison, then puts the collation declaration back. This has been
//     verified, against the real Anki 26.09.2 library, to be *functionally*
//     safe: `col.decks.id(name)` still resolves the new deck, a note added to
//     it still lands in it, and `col.fix_integrity()` reports no problems.
//     What it does not guarantee is that the deck list's on-disk sort order
//     is exactly what a genuine unicase-ordered index would have produced -
//     concretely, a newly created deck can appear in the wrong position in a
//     raw index scan until the user next runs Tools > Check Database, which
//     rebuilds the index with Anki's real collation and fixes this as a side
//     effect. This is a cosmetic-ordering gap, not a data-loss or corruption
//     one, and it is exercised directly in test/collection/decks.test.js.

const { withCollection } = require('./open');

const DEFAULT_DECK_CONFIG_ID = 1;

// decks.proto, Deck.Common: study_collapsed (field 1, varint) and
// browser_collapsed (field 2, varint), both true - the same default
// Deck::new_normal() uses (rslib/src/decks/mod.rs). Verified byte-for-byte
// against what the installed Anki library writes for a fresh deck.
const DEFAULT_COMMON_BLOB = Buffer.from([0x08, 0x01, 0x10, 0x01]);
// decks.proto, Deck.KindContainer{ normal: Deck.Normal{ config_id: 1 } }:
// field 1 (normal, length-delimited, 2 bytes) wrapping field 1 of Normal
// (config_id, varint 1). Also verified byte-for-byte.
const DEFAULT_KIND_BLOB = Buffer.from([0x0a, 0x02, 0x08, 0x01]);

/** name.rs, invalid_char_for_deck_component: ascii control characters, including \x1f itself. */
function isInvalidDeckComponentChar(ch) {
  const code = ch.codePointAt(0);
  return code <= 0x1f || code === 0x7f;
}

/** name.rs, normalized_deck_name_component. */
function normalizeComponent(component) {
  let out = component.normalize('NFC');
  out = [...out].filter((ch) => !isInvalidDeckComponentChar(ch)).join('');
  const trimmed = out.replace(/^[\s:]+|[\s:]+$/g, '');
  return trimmed.length === 0 ? 'blank' : trimmed;
}

/** A human "::"-separated deck name into its normalized components (name.rs, NativeDeckName::from_human_name). */
function humanNameToComponents(humanName) {
  return humanName.split('::').map(normalizeComponent);
}

/** Best-effort Anki-compatible case fold for matching; see the module comment for its limits. */
function foldKey(name) {
  return name.toLowerCase().normalize('NFC');
}

function ancestorPaths(components) {
  const paths = [];
  for (let i = 1; i < components.length; i += 1) paths.push(components.slice(0, i));
  return paths;
}

// ---- schema 11: col.decks is a JSON object keyed by id ----

function newDeckJson(id, name, mtimeSecs) {
  return {
    id,
    mod: mtimeSecs,
    name,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: true,
    browserCollapsed: true,
    desc: '',
    dyn: 0,
    conf: DEFAULT_DECK_CONFIG_ID,
    extendNew: 0,
    extendRev: 0,
    reviewLimit: null,
    newLimit: null,
    reviewLimitToday: null,
    newLimitToday: null,
    desiredRetention: null,
  };
}

function allocId(existingIds, wanted) {
  if (!existingIds.has(wanted)) return wanted;
  let max = wanted;
  for (const id of existingIds) if (id > max) max = id;
  return max + 1;
}

function listDecksLegacy(db) {
  const decks = JSON.parse(db.prepare('SELECT decks FROM col').get().decks);
  return Object.values(decks).map((deck) => ({ id: deck.id, name: deck.name }));
}

function resolveOrCreateDeckLegacy(db, humanName, now) {
  const decks = JSON.parse(db.prepare('SELECT decks FROM col').get().decks);
  const byFold = new Map(Object.values(decks).map((deck) => [foldKey(deck.name), deck]));

  const components = humanNameToComponents(humanName);
  const existingIds = new Set(Object.values(decks).map((deck) => deck.id));
  let created = false;

  for (const prefix of [...ancestorPaths(components), components]) {
    const name = prefix.join('::');
    const existing = byFold.get(foldKey(name));
    if (existing) continue;
    const id = allocId(existingIds, Date.now());
    existingIds.add(id);
    const deck = newDeckJson(id, name, now);
    decks[String(id)] = deck;
    byFold.set(foldKey(name), deck);
    created = true;
  }

  db.prepare('UPDATE col SET decks = ?, mod = ? WHERE id = 1').run(JSON.stringify(decks), Date.now());

  const finalDeck = byFold.get(foldKey(components.join('::')));
  return { deck: { id: finalDeck.id, name: finalDeck.name }, created };
}

// ---- schema 18: a `decks` table, name COLLATE unicase, \x1f-separated ----

function listDecksSchema18(db) {
  return db
    .prepare('SELECT id, name FROM decks')
    .all()
    .map((row) => ({ id: Number(row.id), name: row.name.replace(/\x1f/g, '::') }));
}

/**
 * Run `fn(db)` with `decks.name`'s COLLATE unicase temporarily removed from
 * the live collection's own schema text, restoring it before returning - see
 * the module comment for why this is necessary and what it does and does not
 * guarantee.
 */
function withDecksCollationRelaxed(db, fn) {
  // Captured up front and restored verbatim afterwards, rather than
  // reconstructed by pattern-matching a second time on the way out: exact
  // round-trip of whatever Anki actually wrote, immune to this table's DDL
  // being reformatted (whitespace, column order) by some future Anki version.
  const originalSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'decks'").get().sql;

  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema = ON');
  db.exec("UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '') WHERE name = 'decks'");
  db.exec('PRAGMA writable_schema = RESET');
  try {
    return fn();
  } finally {
    db.exec('PRAGMA writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'decks'").run(originalSql);
    db.exec('PRAGMA writable_schema = RESET');
  }
}

function resolveOrCreateDeckSchema18(db, humanName, now) {
  const existing = db.prepare('SELECT id, name FROM decks').all();
  const byFold = new Map(existing.map((row) => [foldKey(row.name.replace(/\x1f/g, '::')), row]));
  const existingIds = new Set(existing.map((row) => Number(row.id)));

  const components = humanNameToComponents(humanName);
  const toCreate = [];
  for (const prefix of [...ancestorPaths(components), components]) {
    const nativeName = prefix.join('\x1f');
    const key = foldKey(prefix.join('::'));
    if (byFold.has(key)) continue;
    const id = allocId(existingIds, Date.now() + toCreate.length);
    existingIds.add(id);
    toCreate.push({ id, nativeName, key });
  }

  if (toCreate.length === 0) {
    const finalRow = byFold.get(foldKey(components.join('::')));
    return { deck: { id: Number(finalRow.id), name: finalRow.name.replace(/\x1f/g, '::') }, created: false };
  }

  withDecksCollationRelaxed(db, () => {
    const insert = db.prepare(
      // vendor/anki-src/rslib/src/storage/deck/add_or_update_deck.sql, adapted with the same
      // id-collision fallback vendor/anki-src/rslib/src/storage/deck/alloc_id.sql performs
      // (both used together in storage/deck/mod.rs, SqliteStorage::add_deck).
      'INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)',
    );
    for (const entry of toCreate) {
      insert.run(entry.id, entry.nativeName, now, DEFAULT_COMMON_BLOB, DEFAULT_KIND_BLOB);
    }
  });

  db.prepare('UPDATE col SET mod = ? WHERE id = 1').run(Date.now());

  const last = toCreate[toCreate.length - 1];
  return { deck: { id: last.id, name: last.nativeName.replace(/\x1f/g, '::') }, created: true };
}

/** Every deck in the collection, given an already-open handle - the shared read both listDecks and deckAndChildIds build on. */
function listDecksForSchema(db, schemaVersion) {
  return schemaVersion === 11 ? listDecksLegacy(db) : listDecksSchema18(db);
}

/**
 * Every deck in the collection.
 * @returns {{status: string, result?: {id:number, name:string}[]}}
 */
function listDecks(collectionPath) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => listDecksForSchema(db, schemaVersion));
}

/**
 * `deckId` plus every deck nested under it ("Korean" also covers
 * "Korean::Verbs", "Korean::Verbs::Irregular", ...) - what browsing, counting
 * or dedupe-checking "a deck" actually means in Anki: cards.did only ever
 * names the exact deck a card lives in, but a user (and Anki's own browser,
 * and col.decks.deck_and_child_ids, which bridge_ops.py's list_notes_in_deck
 * and list_field_values call directly) expects "this deck" to include its
 * subdecks.
 *
 * This used to be `did = ?` with no expansion at all in every caller in
 * notes.js, which was a genuine cross-transport bug rather than a narrower
 * approximation like foldKey's: a deck with subdecks would show a different
 * note count/list, and the bulk-add dedupe would miss different notes,
 * depending on whether Anki was open (bridge, which already expanded) or
 * closed (direct, which didn't) for the exact same collection file. Matched
 * here with the same ASCII-fold approximation decks.js already uses for
 * dedup elsewhere (see foldKey's own limits above) - a name that only
 * collides with unicase's fuller Unicode folding is missed the same narrow
 * way a duplicate deck create would miss it, never a data-loss risk, and it
 * still fixes the common case (including every non-Latin deck name a real
 * user has) that "no expansion at all" got wrong outright.
 *
 * Returns `[deckId]` unchanged if `deckId` doesn't match any deck in the
 * collection at all (a caller-supplied id no deck actually has) - the same
 * "just query for it, get nothing back" behaviour every caller already had.
 */
function deckAndChildIds(db, schemaVersion, deckId) {
  const all = listDecksForSchema(db, schemaVersion);
  const target = all.find((deck) => deck.id === deckId);
  if (!target) return [deckId];
  const prefix = `${foldKey(target.name)}::`;
  const ids = [deckId];
  for (const deck of all) {
    if (deck.id !== deckId && foldKey(deck.name).startsWith(prefix)) ids.push(deck.id);
  }
  return ids;
}

/**
 * Find a deck by its "::"-separated human name, creating it (and any missing
 * ancestors) if it does not exist. A name that already exists, matched
 * case-insensitively (see foldKey's limits above), is returned rather than
 * duplicated - the same behaviour as Anki's own `col.decks.id()`.
 *
 * Callers that need the "back up before the first mutation" guarantee (see
 * backup.js) must take the backup themselves before calling this - this
 * function only performs the write, so it can be used for both mutating and
 * no-op ("already exists") calls without backing up on the read-only path.
 */
function resolveOrCreateDeck(collectionPath, humanName) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const now = Math.floor(Date.now() / 1000);
    return schemaVersion === 11
      ? resolveOrCreateDeckLegacy(db, humanName, now)
      : resolveOrCreateDeckSchema18(db, humanName, now);
  });
}

module.exports = {
  DEFAULT_DECK_CONFIG_ID,
  deckAndChildIds,
  foldKey,
  humanNameToComponents,
  listDecks,
  normalizeComponent,
  resolveOrCreateDeck,
};
