'use strict';

// Naming and on-disk caching of generated clips.
//
// A clip's Anki filename is derived from the text it was generated from. That
// single decision is what makes a re-run cheap and idempotent: if the text did
// not change, the note already points at exactly the file we would produce, so
// there is nothing to generate and nothing to write. If the text did change,
// the name changes with it and the stale clip is replaced rather than silently
// kept. No sidecar state file has to be kept in sync with the deck.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Bump when the voice, prompt or validation policy changes enough that every
// existing clip should be regenerated.
const AUDIO_PROFILE = 'v1';

const OWNED_NAME = /^plusaudio-[0-9a-f]{20}\.mp3$/;
// Clips written by the 2025 scripts this module replaces. Recognising them
// means a deck already augmented by the old tool is updated in place instead of
// ending up with two sound tags per note.
const LEGACY_OWNED_NAME = /_gpt4o\.mp3$/;

function mediaName(text, language) {
  const digest = crypto
    .createHash('sha1')
    .update(`${AUDIO_PROFILE}\n${language}\n${text}`, 'utf8')
    .digest('hex');
  return `plusaudio-${digest.slice(0, 20)}.mp3`;
}

function isOwnedMediaName(filename) {
  return OWNED_NAME.test(filename) || LEGACY_OWNED_NAME.test(filename);
}

/** A content-addressed directory of clips, so a deleted output can be rebuilt for free. */
class AudioCache {
  constructor(dir) {
    this.dir = dir;
  }

  pathFor(filename) {
    return path.join(this.dir, filename);
  }

  get(filename) {
    try {
      return fs.readFileSync(this.pathFor(filename));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  put(filename, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pathFor(filename), data);
  }
}

module.exports = { AUDIO_PROFILE, AudioCache, isOwnedMediaName, mediaName };
