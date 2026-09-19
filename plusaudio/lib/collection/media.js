'use strict';

// Adding a media file to a closed collection's media folder.
//
// collection.media.db2 is a separate SQLite database from collection.anki2,
// tracking one row per media file with its hash and mtime. It is not held
// open by a running Anki the way the collection file is - it is opened fresh
// per operation (rslib/src/media/mod.rs, Collection::media()) with ordinary
// WAL locking, not the collection's exclusive mode - and its own change
// tracker does not compare against the database at all when deciding what to
// rescan; it compares the media folder's mtime against a single stored
// `folder_mtime` value (rslib/src/sync/media/database/client/changetracker.rs,
// ChangeTracker::register_changes) and only then hashes whatever files
// changed. So a file this module writes straight into collection.media/,
// while Anki is closed, needs no database row of its own: the next time Anki
// runs a media sync (or a "Check Media"), the folder's mtime will have moved,
// and Anki will discover the file on its own, exactly as if a user had pasted
// it in with a file manager.
//
// This was verified experimentally, not just read from source: a file dropped
// into collection.media/ from outside, with the collection reopened by the
// real Anki 26.09.2 library, was reported by col.media.check() as present and
// unused (unused because nothing referenced it yet - which is expected; this
// module only adds the file, writing the note field that references it is
// notes.js's job). Writing to the folder is therefore both sufficient and
// much safer than hand-rolling collection.media.db2's schema, which this
// module does not touch at all.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A conservative subset of media/files.rs's normalize_filename /
// disallowed_char: strip control characters and path separators (a caller
// cannot smuggle a path traversal through the "desired name"), and NFC
// normalize. This does not reproduce every Windows-reserved-name and
// length-truncation rule that file does; those exist to protect Anki's own
// sync protocol's filename limits, and a plusaudio-generated clip name
// (plusaudio-<hex>.mp3, see audio-store.js) never comes close to needing them.
function normalizeFilename(desiredName) {
  const base = path.basename(desiredName).normalize('NFC');
  const cleaned = [...base].filter((ch) => ch.codePointAt(0) > 0x1f && ch.codePointAt(0) !== 0x7f).join('');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`"${desiredName}" is not a usable media filename`);
  }
  return cleaned;
}

function addHashSuffix(filename, sha1Hex) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${sha1Hex}${ext}`;
}

/**
 * Write `data` into `<profileDir>/collection.media/`, choosing a name that
 * both matches Anki's own add_data_to_folder_uniquely (files/rs) and never
 * silently overwrites a different file that happens to share the desired
 * name: if a file with that name already exists and has the same content,
 * its existing name is reused (idempotent); if it exists with different
 * content, the new file gets a `-<sha1>` suffix instead of clobbering it.
 *
 * @param {string} mediaDir  the collection's collection.media/ folder
 * @param {string} desiredName
 * @param {Buffer} data
 * @returns the filename actually used
 */
function addMediaFile(mediaDir, desiredName, data) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');

  let filename = normalizeFilename(desiredName);
  for (const candidate of [filename, filename.toLowerCase()]) {
    const candidatePath = path.join(mediaDir, candidate);
    let existing;
    try {
      existing = fs.readFileSync(candidatePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.writeFileSync(candidatePath, data);
      return candidate;
    }
    if (crypto.createHash('sha1').update(existing).digest('hex') === sha1) return candidate;
  }

  filename = addHashSuffix(filename.toLowerCase(), sha1);
  fs.writeFileSync(path.join(mediaDir, filename), data);
  return filename;
}

/** The collection.media/ folder for a given collection.anki2 path. */
function mediaDirFor(collectionPath) {
  return `${collectionPath.replace(/\.anki2$/, '')}.media`;
}

module.exports = { addMediaFile, mediaDirFor, normalizeFilename };
