'use strict';

// Hides plusaudio/.env for the duration of a test that wants to prove "no
// OPENAI_API_KEY anywhere" behaviour, then restores it - used by both
// generate-clip.test.js and generate-card-text.test.js, whose main()
// functions each fall back to this same real, gitignored file. `node --test`
// runs separate test files as separate processes, potentially concurrently,
// so two files racing to rename the same real file is a real hazard, not a
// hypothetical one; a lock file (created with the exclusive 'wx' flag, which
// fails atomically if another process already holds it) is what makes only
// one of them touch it at a time.

const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const BACKUP_PATH = `${ENV_PATH}.hide-env-backup`;
const LOCK_PATH = `${ENV_PATH}.hide-env-lock`;

function acquireLock() {
  for (;;) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another test file holds it; this is short-lived (a rename or two),
      // so a tight synchronous spin is fine rather than worth an async wait.
    }
  }
}

function releaseLock() {
  fs.unlinkSync(LOCK_PATH);
}

/** Runs `fn` with plusaudio/.env absent (if it existed), restoring it afterward. */
async function withEnvHidden(fn) {
  acquireLock();
  try {
    const hadEnvFile = fs.existsSync(ENV_PATH);
    if (hadEnvFile) fs.renameSync(ENV_PATH, BACKUP_PATH);
    try {
      return await fn();
    } finally {
      if (hadEnvFile) fs.renameSync(BACKUP_PATH, ENV_PATH);
    }
  } finally {
    releaseLock();
  }
}

module.exports = { withEnvHidden };
