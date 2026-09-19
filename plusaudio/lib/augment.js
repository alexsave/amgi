'use strict';

// Add generated audio to an existing .apkg, in place, preserving identity.
//
// The whole point of this module is what it does NOT do. It does not renumber
// notes, cards, note types or decks; it does not rename decks; it does not
// touch `revlog`; it does not stamp `mod` on a note it did not change. Anki
// matches incoming notes by GUID and updates a matched note's fields without
// ever touching its cards' scheduling, so preserving identity is the entire
// mechanism by which a re-run updates the user's deck instead of cloning it.
//
// References for the import rules this relies on:
//   rslib/src/import_export/package/apkg/import/notes.rs  (guid match, IfNewer)
//   rslib/src/import_export/package/apkg/import/cards.rs  (existing cards kept)
//   rslib/src/import_export/package/apkg/import/decks.rs  (decks matched by name)

const { openPackage, writePackage } = require('./package');
const {
  AUDIO_TAG_FORMS,
  audioReferences,
  fieldChecksum,
  joinFields,
  readNotetypes,
  resolveFields,
  setOwnedAudio,
  spokenText,
  splitFields,
  stripHtmlPreservingMedia,
} = require('./deck');
const { AudioCache, isOwnedMediaName, mediaName } = require('./audio-store');

/**
 * @param {object} options
 * @param {string} options.inputPath        .apkg to read
 * @param {string} options.outputPath       .apkg to write
 * @param {function} options.generate       async ({text, language, filename}) => Buffer
 * @param {string} [options.cacheDir]       directory of previously generated clips
 * @param {string} [options.language]       language tag passed to the generator
 * @param {string|number} [options.textField]   field name or index to read aloud
 * @param {string|number} [options.audioField]  field name or index to write into
 * @param {'sound'|'html'} [options.audioTag]   reference to write: [sound:] or <audio src>
 * @param {number} [options.limit]          stop after this many generations
 * @param {boolean} [options.dryRun]        report the plan; generate and write nothing
 * @param {number} [options.now]            epoch seconds to stamp changed notes with
 * @param {function} [options.log]
 */
async function augmentPackage(options) {
  const {
    inputPath,
    outputPath,
    generate,
    cacheDir,
    language = 'ko',
    textField,
    audioField,
    audioTag = 'sound',
    limit = Infinity,
    dryRun = false,
    now = Math.floor(Date.now() / 1000),
    log = () => {},
  } = options;

  if (!AUDIO_TAG_FORMS.includes(audioTag)) {
    throw new Error(`unknown audio tag form "${audioTag}"; expected one of ${AUDIO_TAG_FORMS.join(', ')}`);
  }

  const pkg = openPackage(inputPath);
  try {
    const notetypes = readNotetypes(pkg);
    const fieldsByNotetype = new Map();
    // A media map entry whose numbered member is missing from the zip is a
    // dangling reference; treat the file as absent so it gets regenerated
    // rather than leaving a note pointing at nothing.
    const memberNames = new Set(pkg.entries.map((entry) => entry.name));
    const presentMedia = new Set(
      Object.entries(pkg.mediaMap)
        .filter(([id]) => memberNames.has(id))
        .map(([, name]) => name),
    );
    const cache = cacheDir ? new AudioCache(cacheDir) : null;
    const addedMedia = new Map();

    const summary = {
      format: pkg.format,
      notesTotal: 0,
      notesChanged: 0,
      audioUpToDate: 0,
      audioFromCache: 0,
      audioGenerated: 0,
      skipped: [],
    };

    const notes = pkg.db.prepare('SELECT id, flds, mid, sfld, csum FROM notes ORDER BY id').all();
    summary.notesTotal = notes.length;

    const updateNote = pkg.db.prepare(
      'UPDATE notes SET flds = ?, mod = ?, usn = -1, sfld = ?, csum = ? WHERE id = ?',
    );

    for (const note of notes) {
      const notetype = notetypes.get(Number(note.mid));
      if (!notetype) {
        summary.skipped.push({ id: note.id, reason: 'unknown-note-type' });
        continue;
      }

      if (!fieldsByNotetype.has(notetype.id)) {
        fieldsByNotetype.set(notetype.id, resolveFields(notetype, { textField, audioField }));
      }
      const { textIndex, audioIndex } = fieldsByNotetype.get(notetype.id);

      const fields = splitFields(note.flds);
      const text = spokenText(fields[textIndex] ?? '');
      if (!text) {
        summary.skipped.push({ id: note.id, reason: 'empty-text' });
        continue;
      }

      const wanted = mediaName(text, language);
      const currentOwned = audioReferences(fields[audioIndex] ?? '').filter((reference) =>
        isOwnedMediaName(reference.name),
      );
      // The form counts as much as the filename: a deck augmented with
      // [sound:] tags and re-run with --audio-tag html has the right clip in
      // the wrong shape, and has to be rewritten to the new one.
      const upToDate =
        currentOwned.length === 1 &&
        currentOwned[0].name === wanted &&
        currentOwned[0].form === audioTag &&
        (presentMedia.has(wanted) || addedMedia.has(wanted));
      if (upToDate) {
        summary.audioUpToDate += 1;
        continue;
      }

      // The clip is only needed if the package does not already carry it, which
      // is also what makes a second note with the same text cost nothing.
      if (!addedMedia.has(wanted) && !presentMedia.has(wanted)) {
        let audio = cache ? cache.get(wanted) : null;
        if (audio) {
          summary.audioFromCache += 1;
        } else if (dryRun) {
          summary.audioGenerated += 1;
          audio = Buffer.alloc(0);
        } else {
          if (summary.audioGenerated >= limit) {
            summary.skipped.push({ id: note.id, reason: 'limit-reached' });
            continue;
          }
          try {
            audio = await generate({ text, language, filename: wanted });
          } catch (error) {
            summary.skipped.push({ id: note.id, reason: `generation-failed: ${error.message}` });
            continue;
          }
          if (!audio || audio.length === 0) {
            summary.skipped.push({ id: note.id, reason: 'generation-produced-nothing' });
            continue;
          }
          summary.audioGenerated += 1;
          if (cache) cache.put(wanted, audio);
        }
        addedMedia.set(wanted, audio);
      }

      // A note that is short of its note type's fields would otherwise lose the
      // separator count Anki expects once we write into the audio field.
      while (fields.length < notetype.fieldNames.length) fields.push('');

      fields[audioIndex] = setOwnedAudio(fields[audioIndex] ?? '', wanted, isOwnedMediaName, audioTag);
      const flds = joinFields(fields);
      if (flds === note.flds) {
        summary.audioUpToDate += 1;
        continue;
      }

      // Recompute only the derived columns whose source field we actually
      // touched; anything else keeps the value Anki itself wrote.
      const sfld =
        audioIndex === notetype.sortFieldIndex ? stripHtmlPreservingMedia(fields[audioIndex]) : note.sfld;
      const csum = audioIndex === 0 ? fieldChecksum(fields[0]) : note.csum;

      updateNote.run(flds, now, sfld, csum, note.id);
      summary.notesChanged += 1;
      log(`updated note ${note.id}: ${text}`);
    }

    summary.mediaAdded = addedMedia.size;
    if (!dryRun) writePackage(pkg, outputPath, addedMedia);
    return summary;
  } finally {
    pkg.close();
  }
}

module.exports = { augmentPackage };
