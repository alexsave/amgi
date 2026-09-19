'use strict';

// Reading and writing .apkg packages, and nothing else: no knowledge of notes,
// audio or Anki's import rules lives here.

const { DatabaseSync } = require('node:sqlite');
const { readZip, writeZip } = require('./zip');

const LEGACY1_COLLECTION = 'collection.anki2';
const LEGACY2_COLLECTION = 'collection.anki21';
const MODERN_COLLECTION = 'collection.anki21b';
const MEDIA_MEMBER = 'media';
const META_MEMBER = 'meta';

// Media that is already compressed; deflating it again buys nothing.
const PRECOMPRESSED = /\.(mp3|ogg|opus|m4a|aac|flac|wav|jpg|jpeg|png|gif|webp|webm|mp4|mov)$/i;

class UnsupportedPackageError extends Error {}

// `meta` is a protobuf message whose only field is the package version, as a
// varint under tag 1. Its absence means the original format, which is what Anki
// itself assumes (rslib/src/import_export/package/meta.rs).
function packageVersion(metaEntry) {
  if (!metaEntry) return 1;
  const bytes = metaEntry.data();
  if (bytes.length >= 2 && bytes[0] === 0x08 && bytes[1] < 0x80) return bytes[1];
  return 0;
}

/**
 * Open an .apkg and return its collection database and media map.
 *
 * Only the two legacy layouts are supported. The modern layout stores the
 * collection zstd-compressed and the media map as protobuf; rather than carry a
 * half-correct reader for it, we refuse it and say how to re-export.
 */
function openPackage(filePath) {
  const entries = readZip(filePath);
  const byName = new Map(entries.map((e) => [e.name, e]));

  // Which database Anki reads is decided by `meta`, not by which members
  // happen to be in the zip: a version 1 package with a stray collection.anki21
  // is still read from collection.anki2, and editing the other one would be a
  // silent no-op.
  const version = packageVersion(byName.get(META_MEMBER));
  if (version !== 1 && version !== 2) {
    throw new UnsupportedPackageError(
      `${filePath} is a modern Anki package (version ${version || 'unrecognised'}). ` +
        'Re-export it from Anki with "Support older Anki versions" ticked.',
    );
  }

  const collectionName = version === 2 ? LEGACY2_COLLECTION : LEGACY1_COLLECTION;
  const collectionEntry = byName.get(collectionName);
  if (!collectionEntry) {
    throw new UnsupportedPackageError(
      `${filePath} declares package version ${version} but has no ${collectionName}`,
    );
  }
  if (byName.has(MODERN_COLLECTION)) {
    throw new UnsupportedPackageError(
      `${filePath} contains ${MODERN_COLLECTION}, so it is a modern package. ` +
        'Re-export it from Anki with "Support older Anki versions" ticked.',
    );
  }

  const db = new DatabaseSync(':memory:');
  db.deserialize(collectionEntry.data());

  const schemaVersion = db.prepare('SELECT ver FROM col').get().ver;
  if (schemaVersion !== 11) {
    db.close();
    throw new UnsupportedPackageError(
      `${filePath} uses collection schema ${schemaVersion}; only the legacy schema 11 is supported`,
    );
  }

  const mediaEntry = byName.get(MEDIA_MEMBER);
  let mediaMap = {};
  if (mediaEntry) {
    const text = mediaEntry.data().toString('utf8').trim();
    if (text) {
      try {
        mediaMap = JSON.parse(text);
      } catch {
        db.close();
        throw new UnsupportedPackageError(
          `${filePath} has a non-JSON media map, which means it is a modern package`,
        );
      }
    }
  }

  return {
    filePath,
    format: collectionName === LEGACY2_COLLECTION ? 'legacy2' : 'legacy1',
    collectionName,
    entries,
    db,
    mediaMap,
  };
}

/**
 * Write a package derived from an open one.
 *
 * Every member of the source is carried through untouched except the collection
 * database and the media map. Added media is appended under fresh numeric ids,
 * so existing ids - which the notes' `[sound:]` tags do not reference, but which
 * a partially written package might - never move.
 *
 * @param {object} pkg          the value returned by openPackage
 * @param {string} outPath
 * @param {Map<string, Buffer>} addedMedia  Anki filename -> file contents
 */
function writePackage(pkg, outPath, addedMedia = new Map()) {
  const mediaMap = { ...pkg.mediaMap };
  const idByName = new Map(Object.entries(mediaMap).map(([id, name]) => [name, id]));

  let nextId = 0;
  for (const id of Object.keys(mediaMap)) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
  }

  // Numeric member name -> replacement contents, for media we are adding or
  // overwriting in place.
  const newMembers = new Map();
  for (const [name, data] of addedMedia) {
    let id = idByName.get(name);
    if (id === undefined) {
      id = String(nextId);
      nextId += 1;
      mediaMap[id] = name;
      idByName.set(name, id);
    }
    newMembers.set(id, { name, data });
  }

  const collection = Buffer.from(pkg.db.serialize());
  const out = [];
  const seen = new Set();

  for (const entry of pkg.entries) {
    if (entry.name.endsWith('/')) continue;
    seen.add(entry.name);
    if (entry.name === pkg.collectionName) {
      out.push({ name: entry.name, data: collection });
    } else if (entry.name === MEDIA_MEMBER) {
      out.push({ name: MEDIA_MEMBER, data: Buffer.from(JSON.stringify(mediaMap), 'utf8') });
    } else if (newMembers.has(entry.name)) {
      const replacement = newMembers.get(entry.name);
      newMembers.delete(entry.name);
      out.push({
        name: entry.name,
        data: replacement.data,
        store: PRECOMPRESSED.test(replacement.name),
      });
    } else {
      // Lazy, so a deck's media is decompressed one member at a time rather
      // than all at once. Round-tripping through inflate and deflate rather
      // than copying the compressed bytes costs time but verifies every CRC.
      out.push({ name: entry.name, data: () => entry.data(), store: entry.method === 0 });
    }
  }

  if (!seen.has(MEDIA_MEMBER)) {
    out.push({ name: MEDIA_MEMBER, data: Buffer.from(JSON.stringify(mediaMap), 'utf8') });
  }
  for (const [id, replacement] of newMembers) {
    out.push({ name: id, data: replacement.data, store: PRECOMPRESSED.test(replacement.name) });
  }

  writeZip(outPath, out);
}

module.exports = { openPackage, writePackage, UnsupportedPackageError };
