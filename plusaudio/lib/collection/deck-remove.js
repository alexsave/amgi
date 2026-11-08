'use strict';

// Deleting a deck the way Anki deletes one, for the direct transport (Anki closed).
//
// The reference is Anki's own remove_decks_and_child_decks (rslib/src/decks/remove.rs in Anki
// 26.09.4, the RemoveDecks call of vendor/anki-src/proto/anki/decks.proto; the bridge transport
// calls it through col.decks.remove). For the deck and every deck under it, it does this, and this
// module does the same:
//
//  - A normal deck: every card whose deck is that deck, or whose home deck is (a card sitting in
//    a filtered deck somewhere else), is removed with a card grave; then every note left with no
//    card at all is removed with a note grave (card/mod.rs, remove_cards_and_orphaned_notes). A
//    note that still has a card in another deck stays.
//  - A filtered deck: its cards are not deleted but sent back to their home deck, their due and
//    queue restored (scheduler/filtered/card.rs, remove_from_filtered_deck_restoring_queue), and
//    marked modified. A card whose home is inside the deleted tree is deleted by its home's pass.
//  - Its per-deck config keys ("_deck_<id>_...", such as the last note type used in it) are
//    removed (config/deck.rs, clear_aux_config_for_deck).
//  - The deck row is removed with a deck grave. The Default deck (id 1) is the exception: Anki
//    never removes it, it empties it and resets its name to "Default". So a delete of Default would
//    only empty it, which is not what "delete" says; this module and the bridge refuse id 1
//    outright, and the page never offers it. Default can still be reached as a subdeck (someone
//    renamed it to "A::Default"), and then it is treated exactly as Anki treats it.
//
// What Anki leaves alone, and so does this: the review log (revlog rows stay; Anki keeps them for
// the collection's statistics), the deck options presets (deck_config), and the schema-modified
// time (col.scm). Graves carry usn -1, as every other change this package writes: pending, to be
// sent on the next sync. So a deck deletion is an ordinary incremental sync, not a full one: the
// graves tell the server and every other device to delete the same cards, notes and decks.
//
// The work runs in one transaction: a failure part way leaves the file as it was.
//
// Schema 18 keeps decks.name under COLLATE unicase, which node:sqlite cannot supply, and deleting
// a row has to find its entry in the name index. So the delete runs with the collation relaxed to
// NOCASE, as decks.js's writes do (see its module comment), and then checks that the name index
// holds exactly the rows the table holds. NOCASE and unicase agree on every name that is ASCII or
// has no case (Korean, Japanese, Chinese); a pair of names that differ only by non-ASCII case
// could in principle send the index search astray, and that check turns it into a refused,
// rolled-back delete rather than a stale index entry.

const { foldKey, withDecksCollationRelaxed } = require('./decks');
const { withCollection } = require('./open');

const DEFAULT_DECK_ID = 1;
const DEFAULT_DECK_NAME = 'Default';

// decks.proto, Deck.KindContainer: field 1 (normal) or field 2 (filtered), both length-delimited,
// so the first byte of the blob is 0x0a for a normal deck and 0x12 for a filtered one.
const FILTERED_KIND_TAG = 0x12;

// scheduler/timing.rs, is_unix_epoch_timestamp: a learning card's due is a unix time, a day
// learning card's a day number.
const UNIX_EPOCH_DUE = 1_000_000_000;

/** An error the HTTP route answers with `status` (404: the deck is not there). */
function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

function placeholders(ids) {
  return ids.map(() => '?').join(',');
}

/** Every deck as {id, name ("::"-separated), filtered}, and for schema 11 the parsed col.decks. */
function readDecks(db, schemaVersion) {
  if (schemaVersion === 11) {
    const json = JSON.parse(db.prepare('SELECT decks FROM col').get().decks);
    const decks = Object.values(json).map((d) => ({ id: Number(d.id), name: d.name, filtered: d.dyn === 1 }));
    return { decks, json };
  }
  const decks = db
    .prepare('SELECT id, name, kind FROM decks')
    .all()
    .map((row) => ({
      id: Number(row.id),
      name: row.name.replaceAll('\x1f', '::'),
      filtered: row.kind.length > 0 && row.kind[0] === FILTERED_KIND_TAG,
    }));
  return { decks };
}

/**
 * What deleting `deckId` takes, without changing anything: the deck and its subdecks (in name
 * order, the preorder Anki walks), the cards that go, the cards that go back from a filtered deck,
 * and the notes left with no card. null when there is no such deck.
 */
function plan(db, schemaVersion, deckId) {
  const { decks, json } = readDecks(db, schemaVersion);
  const target = decks.find((d) => d.id === Number(deckId));
  if (!target) return null;
  // The same deck-and-descendants rule as decks.js's deckAndChildIds (and Anki's child_decks,
  // whose name range compares under unicase): a "::"-prefix, case folded.
  const prefix = `${foldKey(target.name)}::`;
  const children = decks
    .filter((d) => d.id !== target.id && foldKey(d.name).startsWith(prefix))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tree = [target, ...children];
  const normal = tree.filter((d) => !d.filtered).map((d) => d.id);
  const filtered = tree.filter((d) => d.filtered).map((d) => d.id);

  // storage/deck/cards_for_deck.sql, for every normal deck of the tree at once: a card goes when
  // its deck, or its home deck, is one of them.
  const list = placeholders(normal);
  const goes = (t) => `(${t}.did IN (${list}) OR (${t}.odid != 0 AND ${t}.odid IN (${list})))`;
  const cards = db.prepare(`SELECT c.id FROM cards c WHERE ${goes('c')}`).all(...normal, ...normal).map((r) => Number(r.id));
  const notes = db
    .prepare(
      `SELECT DISTINCT c.nid FROM cards c WHERE ${goes('c')}
       AND NOT EXISTS (SELECT 1 FROM cards o WHERE o.nid = c.nid AND NOT ${goes('o')})`,
    )
    .all(...normal, ...normal, ...normal, ...normal)
    .map((r) => Number(r.nid));
  const returned = db
    .prepare(
      `SELECT c.id, c.odid, c.odue, c.due, c.type, c.queue FROM cards c
       WHERE c.did IN (${placeholders(filtered)}) AND NOT ${goes('c')}`,
    )
    .all(...filtered, ...normal, ...normal);
  return { target, tree, cards, notes, returned, json };
}

/** {id, name, subdecks, cards, notes}: what the confirmation names before anything goes. */
function summarize(found) {
  return {
    id: found.target.id,
    name: found.target.name,
    subdecks: found.tree.length - 1,
    cards: found.cards.length,
    notes: found.notes.length,
  };
}

/**
 * What deleting `deckId` (and everything under it) would take, read only.
 * @returns {{status: string, result?: {id, name, subdecks, cards, notes}}}
 */
function deckRemovalSummary(collectionPath, deckId) {
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    const found = plan(db, schemaVersion, deckId);
    if (!found) throw statusError(`no deck with id ${deckId} in this collection`, 404);
    return summarize(found);
  });
}

/** card.rs, remove_from_filtered_deck_restoring_queue, then set_modified. */
function returnHome(db, rows, now) {
  const update = db.prepare('UPDATE cards SET did = ?, odid = 0, due = ?, odue = 0, queue = ?, mod = ?, usn = -1 WHERE id = ?');
  const touch = db.prepare('UPDATE cards SET mod = ?, usn = -1 WHERE id = ?');
  for (const card of rows) {
    if (Number(card.odid) === 0) {
      touch.run(now, card.id);
      continue;
    }
    const due = Number(card.odue) !== 0 ? Number(card.odue) : Number(card.due);
    let queue = Number(card.queue);
    if (queue >= 0) {
      const type = Number(card.type);
      // type 0 new -> queue 0; 2 review -> 2; 1 learn / 3 relearn -> 1 (learn) or 3 (day learn)
      queue = type === 1 || type === 3 ? (due > UNIX_EPOCH_DUE ? 1 : 3) : type;
    }
    update.run(card.odid, due, queue, now, card.id);
  }
}

function removeRows(db, found) {
  const grave = db.prepare('INSERT OR IGNORE INTO graves (usn, oid, type) VALUES (-1, ?, ?)'); // graves/add.sql
  const delCard = db.prepare('DELETE FROM cards WHERE id = ?');
  for (const id of found.cards) {
    grave.run(id, 0);
    delCard.run(id);
  }
  const delNote = db.prepare('DELETE FROM notes WHERE id = ?');
  for (const id of found.notes) {
    delNote.run(id);
    grave.run(id, 1);
  }
  return grave;
}

function removeSchema18(db, found, now) {
  const grave = removeRows(db, found);
  const dropConfig = db.prepare('DELETE FROM config WHERE substr(KEY, 1, ?) = ?');
  for (const d of found.tree) {
    const key = `_deck_${d.id}_`;
    dropConfig.run(key.length, key);
  }
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'decks'").all();
  withDecksCollationRelaxed(db, () => {
    const delDeck = db.prepare('DELETE FROM decks WHERE id = ?');
    const resetDefault = db.prepare('UPDATE decks SET name = ?, mtime_secs = ?, usn = -1 WHERE id = ?');
    for (const d of found.tree) {
      if (d.id === DEFAULT_DECK_ID) {
        resetDefault.run(DEFAULT_DECK_NAME, now, d.id);
        continue;
      }
      grave.run(d.id, 2);
      delDeck.run(d.id);
    }
    // See the module comment: every index on decks must still hold exactly the table's rows.
    const rows = Number(db.prepare('SELECT count(*) AS n FROM decks NOT INDEXED').get().n);
    for (const { name } of index) {
      const entries = Number(db.prepare(`SELECT count(*) AS n FROM decks INDEXED BY "${name}" WHERE name >= ''`).get().n);
      if (entries !== rows) {
        throw new Error(`deleting the deck left the decks index ${name} with ${entries} entries for ${rows} rows; nothing was changed`);
      }
    }
  });
}

function removeLegacy(db, found, now) {
  const grave = removeRows(db, found);
  const conf = JSON.parse(db.prepare('SELECT conf FROM col').get().conf);
  for (const d of found.tree) {
    const key = `_deck_${d.id}_`;
    for (const k of Object.keys(conf)) if (k.startsWith(key)) delete conf[k];
  }
  const decks = found.json;
  for (const d of found.tree) {
    if (d.id === DEFAULT_DECK_ID) {
      Object.assign(decks[String(d.id)], { name: DEFAULT_DECK_NAME, mod: now, usn: -1 });
      continue;
    }
    grave.run(d.id, 2);
    delete decks[String(d.id)];
  }
  db.prepare('UPDATE col SET decks = ?, conf = ? WHERE id = 1').run(JSON.stringify(decks), JSON.stringify(conf));
}

/**
 * Delete a deck, every deck under it, their cards and the notes left with no card, leaving the
 * graves a sync needs. Refuses the Default deck (see the module comment).
 * @returns {{status: string, result?: {id, name, decks, cards, notes}}}
 */
function removeDeck(collectionPath, deckId) {
  if (Number(deckId) === DEFAULT_DECK_ID) {
    throw statusError('The Default deck cannot be deleted: Anki keeps it, and would only empty it.', 400);
  }
  return withCollection(collectionPath, ({ db, schemaVersion }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const found = plan(db, schemaVersion, deckId);
      if (!found) throw statusError(`no deck with id ${deckId} in this collection`, 404);
      const now = Math.floor(Date.now() / 1000);
      returnHome(db, found.returned, now);
      if (schemaVersion === 11) removeLegacy(db, found, now);
      else removeSchema18(db, found, now);
      db.prepare('UPDATE col SET mod = ? WHERE id = 1').run(Date.now());
      db.exec('COMMIT');
      const s = summarize(found);
      return { id: s.id, name: s.name, decks: found.tree.filter((d) => d.id !== DEFAULT_DECK_ID).length, cards: s.cards, notes: s.notes };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

module.exports = { deckRemovalSummary, removeDeck };
