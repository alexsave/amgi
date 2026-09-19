'use strict';

// A copy of the collection file, taken before this tool changes anything.
//
// Anki keeps its own rolling backups (qt/aqt/main.py, a throttled backup every
// 5 minutes and one on profile close, rslib/src/collection/backup.rs), but
// those only run while Anki itself is open. Every write this package makes
// happens while Anki is closed, so nothing else is watching - a tool that
// edits someone's collection directly and has no backup of its own is one bug
// away from being the only copy of a mistake.

const fs = require('node:fs');
const path = require('node:path');

const BACKUP_DIRNAME = 'amgi-collection-backups';

/**
 * Copy `collectionPath` into a sibling `amgi-collection-backups/` folder,
 * timestamped so repeated runs never overwrite an earlier backup.
 *
 * @returns the path the backup was written to.
 */
function backupCollectionFile(collectionPath) {
  const dir = path.join(path.dirname(collectionPath), BACKUP_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${path.basename(collectionPath)}.${stamp}.bak`);
  fs.copyFileSync(collectionPath, backupPath);
  return backupPath;
}

module.exports = { BACKUP_DIRNAME, backupCollectionFile };
