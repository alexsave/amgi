'use strict';

// Allocating ids the way Anki does: the current epoch millisecond, or one past
// the current maximum if that millisecond is already taken.
//
// Anki does this inline in the INSERT itself (see
// vendor/anki-src/rslib/src/storage/note/add.sql and .../card/add_card.sql,
// both `VALUES ((CASE WHEN ?1 IN (SELECT id FROM <table>) THEN (SELECT
// max(id) + 1 FROM <table>) ELSE ?1 END), ...)`), which is the actual
// mechanism this module reproduces - not a reimplementation of "how to
// generate an id", a port of the exact SQL Anki runs, parameterised by table
// name. Doing it as one statement, same as upstream, avoids a race between
// reading "is this id free" and inserting that a separate SELECT-then-INSERT
// would have (irrelevant for a single-writer offline collection, but free to
// avoid by just running the same SQL Anki does).

/** The VALUES(...) id expression from add.sql/add_card.sql, for `table`. */
function idAllocationExpr(table) {
  return `(CASE WHEN ?1 IN (SELECT id FROM ${table}) THEN (SELECT max(id) + 1 FROM ${table}) ELSE ?1 END)`;
}

const BASE91_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/**
 * A random note GUID: base-91 encoding of a random 64-bit integer
 * (vendor/anki-src proto not needed here - this is plain Rust, see
 * rslib/src/notes/mod.rs, base91_u64 / anki_base91 / to_base_n). The alphabet
 * above is copied verbatim from that function.
 */
function randomGuid(randomBytes = require('node:crypto').randomBytes) {
  let n = 0n;
  // to_base_n's `while n > 0` loop produces an empty string for n == 0; Anki
  // never observes this in practice (1-in-2^64) but this function should
  // never return an empty guid, so it re-rolls on the one input that would.
  while (n === 0n) {
    n = randomBytes(8).readBigUInt64BE(0);
  }
  const table = BigInt(BASE91_ALPHABET.length);
  let out = '';
  while (n > 0n) {
    const r = Number(n % table);
    n /= table;
    out = BASE91_ALPHABET[r] + out;
  }
  return out;
}

module.exports = { BASE91_ALPHABET, idAllocationExpr, randomGuid };
