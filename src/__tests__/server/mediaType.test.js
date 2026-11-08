import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor } from '../../server/anki/mediaType';

test('a Gemini clip is served as wav and an older clip as mp3, so a mixed deck plays both', () => {
  assert.equal(contentTypeFor('plusaudio-0123456789abcdef0123.wav'), 'audio/wav');
  assert.equal(contentTypeFor('plusaudio-0123456789abcdef0123.mp3'), 'audio/mpeg');
  assert.equal(contentTypeFor('plusaudio-0123456789abcdef0123-2.WAV'), 'audio/wav');
});

test('other audio an author recorded keeps its type, and anything else is opaque bytes', () => {
  assert.equal(contentTypeFor('author.ogg'), 'audio/ogg');
  assert.equal(contentTypeFor('author.m4a'), 'audio/mp4');
  assert.equal(contentTypeFor('notes.wav.txt'), 'application/octet-stream');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
});
