/**
 * @jest-environment node
 */

import { contentTypeFor } from '../../server/anki/mediaType';

test('a Gemini clip is served as wav and an older clip as mp3, so a mixed deck plays both', () => {
  expect(contentTypeFor('plusaudio-0123456789abcdef0123.wav')).toBe('audio/wav');
  expect(contentTypeFor('plusaudio-0123456789abcdef0123.mp3')).toBe('audio/mpeg');
  expect(contentTypeFor('plusaudio-0123456789abcdef0123-2.WAV')).toBe('audio/wav');
});

test('other audio an author recorded keeps its type, and anything else is opaque bytes', () => {
  expect(contentTypeFor('author.ogg')).toBe('audio/ogg');
  expect(contentTypeFor('author.m4a')).toBe('audio/mp4');
  expect(contentTypeFor('notes.wav.txt')).toBe('application/octet-stream');
  expect(contentTypeFor('no-extension')).toBe('application/octet-stream');
});
