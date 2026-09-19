'use strict';

// Reading and writing .apkg packages, and nothing else: no knowledge of notes,
// audio or Anki's import rules lives here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const { WIRE_LENGTH, WIRE_VARINT, readFields, writeBytesField, writeVarintField } = require('./protobuf');
const { readZip, writeZip } = require('./zip');

const MEDIA_MEMBER = 'media';
const META_MEMBER = 'meta';

// The three package layouts Anki can write, keyed by the version `meta`
// declares (rslib/src/import_export/package/meta.rs). The version fixes which
// member holds the collection, whether the collection and the media are zstd
// compressed, and whether the media map is a JSON object or a protobuf.
const FORMATS = {
  legacy1: { version: 1, collection: 'collection.anki2', zstd: false },
  legacy2: { version: 2, collection: 'collection.anki21', zstd: false },
  modern: { version: 3, collection: 'collection.anki21b', zstd: true },
};
const FORMAT_BY_VERSION = new Map(
  Object.entries(FORMATS).map(([name, format]) => [format.version, { name, ...format }]),
);

// The collection schemas this tool knows how to read. 11 is what both legacy
// layouts carry; 18 is what a modern package carries, and it keeps note types,
// fields and decks in tables of their own rather than in JSON blobs in `col`
// (meta.rs, Version::schema_version). A collection in any other schema is
// refused rather than guessed at.
const SUPPORTED_SCHEMAS = new Set([11, 18]);

// Media that is already compressed; deflating it again buys nothing.
const PRECOMPRESSED = /\.(mp3|ogg|opus|m4a|aac|flac|wav|jpg|jpeg|png|gif|webp|webm|mp4|mov)$/i;

class UnsupportedPackageError extends Error {}

/**
 * The package version, which decides everything else about the layout.
 *
 * `meta` is a PackageMetadata message whose only field is the version, a varint
 * under tag 1. A package without one predates the member, and Anki reads it as
 * the layout its members imply (meta.rs, Meta::from_archive).
 */
function packageVersion(byName) {
  const metaEntry = byName.get(META_MEMBER);
  if (!metaEntry) return byName.has(FORMATS.legacy2.collection) ? 2 : 1;
  let version = 0;
  for (const field of readFields(metaEntry.data())) {
    if (field.number === 1 && field.wireType === WIRE_VARINT) version = field.value;
  }
  return version;
}

// MediaEntries.MediaEntry (proto/anki/import_export.proto): the name Anki
// stores the file under, the size and SHA-1 of the file's real contents, and a
// legacy field that is only set when a legacy package's media map is converted
// on import and is never written on export.
const MEDIA_ENTRY_NAME = 1;
const MEDIA_ENTRY_SIZE = 2;
const MEDIA_ENTRY_SHA1 = 3;
const MEDIA_ENTRIES_LIST = 1;

/**
 * Decode a modern package's media map.
 *
 * An entry's position in the list is the name of the zip member holding its
 * contents: Anki enumerates the list and looks the file up by index
 * (rslib/src/import_export/package/media.rs, SafeMediaEntry::from_entry and
 * fetch_file). Each entry's own bytes are kept so that an entry we do not
 * change can be written back exactly as it came in, including any field a
 * newer Anki adds that this code does not model.
 */
function decodeMediaEntries(bytes) {
  const entries = [];
  for (const field of readFields(bytes)) {
    if (field.number !== MEDIA_ENTRIES_LIST || field.wireType !== WIRE_LENGTH) continue;
    const entry = { name: '', size: 0, sha1: Buffer.alloc(0), raw: field.bytes };
    for (const inner of readFields(field.bytes)) {
      if (inner.number === MEDIA_ENTRY_NAME && inner.wireType === WIRE_LENGTH) {
        entry.name = inner.bytes.toString('utf8');
      } else if (inner.number === MEDIA_ENTRY_SIZE && inner.wireType === WIRE_VARINT) {
        entry.size = inner.value;
      } else if (inner.number === MEDIA_ENTRY_SHA1 && inner.wireType === WIRE_LENGTH) {
        entry.sha1 = inner.bytes;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function encodeMediaEntries(entries) {
  return Buffer.concat(
    entries.map((entry) => {
      const body =
        entry.raw ??
        Buffer.concat([
          writeBytesField(MEDIA_ENTRY_NAME, Buffer.from(entry.name, 'utf8')),
          writeVarintField(MEDIA_ENTRY_SIZE, entry.size),
          writeBytesField(MEDIA_ENTRY_SHA1, entry.sha1),
        ]);
      return writeBytesField(MEDIA_ENTRIES_LIST, body);
    }),
  );
}

/**
 * Open the collection with Anki's collations stripped from its schema text.
 *
 * Schema 18 declares `COLLATE unicase` on the name columns of its notetype,
 * field, template, deck and tag tables. unicase is Anki's own collation,
 * registered by its Rust backend; node:sqlite cannot register one, and SQLite
 * refuses to plan any statement whose table or index needs a collation it
 * cannot resolve. For `fields` - a WITHOUT ROWID table whose every index
 * carries the collation - that means the table cannot be read at all, and a
 * deserialised in-memory copy cannot even be opened.
 *
 * So the note type metadata is read from a throwaway copy with the collation
 * taken out of the schema text, and the collection we hand back to the caller
 * keeps the schema Anki wrote, byte for byte. Dropping the collation changes
 * only the order SQLite believes an index is in, so every read from this copy
 * takes whole tables and sorts in JavaScript rather than trusting SQL order.
 */
function openWithRelaxedCollations(collectionPath) {
  const copyPath = `${collectionPath}-metadata`;
  fs.copyFileSync(collectionPath, copyPath);
  const db = new DatabaseSync(copyPath);
  // Rewriting sqlite_master is the only way to change a collation after the
  // fact, and node:sqlite turns SQLite's defensive mode on by default, which
  // exists to forbid exactly that.
  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema = ON');
  db.exec("UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '')");
  db.exec('PRAGMA writable_schema = RESET');
  return db;
}

/**
 * Open an .apkg and return its collection database and media map.
 *
 * The caller must call `close()` on the result: the collection is unpacked into
 * a temporary directory, because a schema 18 collection cannot be opened as an
 * in-memory database at all (see openWithRelaxedCollations).
 *
 * @returns {{
 *   filePath: string,
 *   format: 'legacy1'|'legacy2'|'modern',
 *   collectionName: string,
 *   schemaVersion: number,
 *   entries: object[],
 *   db: import('node:sqlite').DatabaseSync,
 *   metadataDb: import('node:sqlite').DatabaseSync,
 *   mediaMap: Record<string, string>,
 *   mediaEntries: object[]|null,
 *   close: function(): void,
 * }}
 *   `db` is the collection as Anki wrote it: the one to edit, and the one
 *   written back out. `metadataDb` is a read-only view of the same collection
 *   for the tables `db` cannot answer questions about; for schema 11 they are
 *   the same object.
 */
function openPackage(filePath) {
  const entries = readZip(filePath);
  const byName = new Map(entries.map((e) => [e.name, e]));

  // Which database Anki reads is decided by `meta`, not by which members
  // happen to be in the zip: a version 1 package with a stray collection.anki21
  // is still read from collection.anki2, and editing the other one would be a
  // silent no-op.
  const version = packageVersion(byName);
  const format = FORMAT_BY_VERSION.get(version);
  if (!format) {
    throw new UnsupportedPackageError(
      `${filePath} declares package version ${version}, which is newer than any layout ` +
        `this tool knows how to read (${[...FORMAT_BY_VERSION.keys()].join(', ')})`,
    );
  }

  const collectionEntry = byName.get(format.collection);
  if (!collectionEntry) {
    throw new UnsupportedPackageError(
      `${filePath} declares package version ${version} but has no ${format.collection}`,
    );
  }

  let collectionBytes;
  try {
    collectionBytes = format.zstd
      ? zlib.zstdDecompressSync(collectionEntry.data())
      : collectionEntry.data();
  } catch (error) {
    throw new UnsupportedPackageError(
      `${filePath} declares package version ${version}, but its ${format.collection} ` +
        `is not zstd-compressed as that version requires: ${error.message}`,
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plusaudio-'));
  const collectionPath = path.join(workDir, format.collection);
  let db = null;
  let metadataDb = null;
  try {
    fs.writeFileSync(collectionPath, collectionBytes);
    db = new DatabaseSync(collectionPath);

    const schemaVersion = db.prepare('SELECT ver FROM col').get().ver;
    if (!SUPPORTED_SCHEMAS.has(schemaVersion)) {
      throw new UnsupportedPackageError(
        `${filePath} uses collection schema ${schemaVersion}; this tool understands ` +
          `${[...SUPPORTED_SCHEMAS].join(' and ')}, and refuses a collection it cannot read correctly`,
      );
    }
    metadataDb = schemaVersion === 11 ? db : openWithRelaxedCollations(collectionPath);

    const mediaEntry = byName.get(MEDIA_MEMBER);
    const { mediaMap, mediaEntries } = readMediaMap(filePath, format, mediaEntry);

    return {
      filePath,
      format: format.name,
      collectionName: format.collection,
      // The unpacked database. writePackage reads the finished collection
      // back off disk from here rather than serializing it out of SQLite.
      collectionPath,
      schemaVersion,
      entries,
      db,
      metadataDb,
      mediaMap,
      mediaEntries,
      close() {
        if (metadataDb !== db) metadataDb.close();
        db.close();
        fs.rmSync(workDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (metadataDb && metadataDb !== db) metadataDb.close();
    if (db) db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The media map, in whichever shape the format stores it, plus the same thing
 * as a plain member-name -> filename object for callers that only need that.
 */
function readMediaMap(filePath, format, mediaEntry) {
  if (!mediaEntry) return { mediaMap: {}, mediaEntries: format.zstd ? [] : null };

  if (format.zstd) {
    let entries;
    try {
      entries = decodeMediaEntries(zlib.zstdDecompressSync(mediaEntry.data()));
    } catch (error) {
      throw new UnsupportedPackageError(
        `${filePath} has a media map that is not a zstd-compressed MediaEntries message, ` +
          `which is what package version ${format.version} requires: ${error.message}`,
      );
    }
    const mediaMap = {};
    entries.forEach((entry, index) => {
      mediaMap[String(index)] = entry.name;
    });
    return { mediaMap, mediaEntries: entries };
  }

  const text = mediaEntry.data().toString('utf8').trim();
  if (!text) return { mediaMap: {}, mediaEntries: null };
  try {
    return { mediaMap: JSON.parse(text), mediaEntries: null };
  } catch {
    throw new UnsupportedPackageError(
      `${filePath} declares package version ${format.version}, whose media map is JSON, ` +
        'but its media map does not parse as JSON',
    );
  }
}

/**
 * Where added media goes in a legacy package: under a fresh numeric member
 * name, so the names already in the map never move.
 */
function planLegacyMedia(pkg, addedMedia) {
  const mediaMap = { ...pkg.mediaMap };
  const idByName = new Map(Object.entries(mediaMap).map(([id, name]) => [name, id]));

  let nextId = 0;
  for (const id of Object.keys(mediaMap)) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
  }

  const members = new Map();
  for (const [name, data] of addedMedia) {
    let id = idByName.get(name);
    if (id === undefined) {
      id = String(nextId);
      nextId += 1;
      mediaMap[id] = name;
      idByName.set(name, id);
    }
    members.set(id, { data, store: PRECOMPRESSED.test(name) });
  }

  return { mapMember: Buffer.from(JSON.stringify(mediaMap), 'utf8'), members };
}

/**
 * The same for a modern package, where an entry's index in the list is the
 * member its contents live under, so a file can only be added by appending.
 *
 * Every media file is zstd-compressed and then stored, which is what the
 * importer expects: it decompresses unconditionally for this package version
 * (media.rs, copy_and_ensure_sha1_set). The size and SHA-1 describe the real
 * contents, not the compressed member, and the importer trusts them to decide
 * whether a file it already holds is the same one, so a rewritten entry has to
 * be re-encoded rather than passed through.
 */
function planModernMedia(pkg, addedMedia) {
  const entries = pkg.mediaEntries.map((entry) => ({ ...entry }));
  const indexByName = new Map(entries.map((entry, index) => [entry.name, index]));

  const members = new Map();
  for (const [name, data] of addedMedia) {
    let index = indexByName.get(name);
    if (index === undefined) {
      index = entries.length;
      entries.push(null);
      indexByName.set(name, index);
    }
    entries[index] = {
      name,
      size: data.length,
      sha1: crypto.createHash('sha1').update(data).digest(),
      raw: null,
    };
    members.set(String(index), { data: zlib.zstdCompressSync(data), store: true });
  }

  return { mapMember: zlib.zstdCompressSync(encodeMediaEntries(entries)), members };
}

/**
 * Write a package derived from an open one.
 *
 * Every member of the source is carried through untouched except the collection
 * database and the media map, and the package comes out in the layout it went
 * in as: a modern package is not quietly downgraded, and a legacy one is not
 * upgraded out from under a client that could not read the result.
 *
 * @param {object} pkg          the value returned by openPackage
 * @param {string} outPath
 * @param {Map<string, Buffer>} addedMedia  Anki filename -> file contents
 */
function writePackage(pkg, outPath, addedMedia = new Map()) {
  const format = FORMATS[pkg.format];
  const { mapMember, members } = format.zstd
    ? planModernMedia(pkg, addedMedia)
    : planLegacyMedia(pkg, addedMedia);

  // The file on disk is the collection. node:sqlite runs in autocommit, so
  // every statement the caller ran is already committed; the checkpoint folds
  // any WAL frames back into the main file, which is a no-op for the rollback
  // journal every Anki export actually uses. Reading it back is byte for byte
  // what DatabaseSync.serialize() returns - and serialize() landed in Node
  // 26.1, which was the only thing forcing this CLI onto a runtime almost
  // nobody has installed.
  pkg.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const collection = fs.readFileSync(pkg.collectionPath);
  const collectionMember = format.zstd ? zlib.zstdCompressSync(collection) : collection;

  const out = [];
  const seen = new Set();

  for (const entry of pkg.entries) {
    if (entry.name.endsWith('/')) continue;
    seen.add(entry.name);
    if (entry.name === pkg.collectionName) {
      // Already zstd-compressed for a modern package, so deflating it again
      // would only cost time.
      out.push({ name: entry.name, data: collectionMember, store: format.zstd });
    } else if (entry.name === MEDIA_MEMBER) {
      out.push({ name: MEDIA_MEMBER, data: mapMember, store: format.zstd });
    } else if (members.has(entry.name)) {
      const replacement = members.get(entry.name);
      members.delete(entry.name);
      out.push({ name: entry.name, data: replacement.data, store: replacement.store });
    } else {
      // Lazy, so a deck's media is decompressed one member at a time rather
      // than all at once. Round-tripping through inflate and deflate rather
      // than copying the compressed bytes costs time but verifies every CRC.
      out.push({ name: entry.name, data: () => entry.data(), store: entry.method === 0 });
    }
  }

  if (!seen.has(MEDIA_MEMBER)) {
    out.push({ name: MEDIA_MEMBER, data: mapMember, store: format.zstd });
  }
  for (const [name, replacement] of members) {
    out.push({ name, data: replacement.data, store: replacement.store });
  }

  writeZip(outPath, out);
}

module.exports = { openPackage, writePackage, UnsupportedPackageError };
