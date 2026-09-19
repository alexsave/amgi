'use strict';

// Where a user's Anki profiles live, and which ones exist.
//
// Anki keeps one "Anki2" base folder per machine, and one subfolder per profile
// inside it (the profile picker's "User 1", "User 2", and so on). Each profile
// folder holds collection.anki2 (the collection this module reads and writes),
// collection.media/ (the media folder) and collection.media.db2 (the media
// change tracker, which this module never touches - see lib/collection/media.js).
//
// Base folder locations are the ones documented for end users, not inferred:
// https://docs.ankiweb.net/files.html#file-locations

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COLLECTION_FILENAME = 'collection.anki2';

/**
 * The default Anki2 base folder for the current platform.
 *
 * Windows: %APPDATA%\Anki2
 * macOS:   ~/Library/Application Support/Anki2
 * Linux:   $XDG_DATA_HOME/Anki2, or ~/.local/share/Anki2 if unset
 */
function defaultBaseDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Anki2');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Anki2');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Anki2');
}

/**
 * Every profile found under a base folder, each with the path to its collection.
 *
 * A profile is any immediate subdirectory that contains a collection.anki2; this
 * excludes the base folder's other children (addons21/, backups/db, prefs21.db)
 * without having to hard-code their names, which is fragile across Anki versions.
 */
function listProfiles(baseDir = defaultBaseDir()) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const collectionPath = path.join(baseDir, entry.name, COLLECTION_FILENAME);
    if (fs.existsSync(collectionPath)) {
      profiles.push({ name: entry.name, collectionPath });
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { COLLECTION_FILENAME, defaultBaseDir, listProfiles };
