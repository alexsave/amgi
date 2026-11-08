// The starter phrase table's one reader (src/server/anki/starterPhrases.js): a whole table or
// nothing, so a damaged file never builds a deck whose two sides say unrelated things.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStarterPhrases, readStarterPhrases } from '../../server/anki/starterPhrases';

test('a header of language codes and a line per concept become a list per language, in order', () => {
  assert.deepEqual(parseStarterPhrases('en\tko\nHello.\t안녕하세요.\nThank you.\t감사합니다.\n'), {
    en: ['Hello.', 'Thank you.'],
    ko: ['안녕하세요.', '감사합니다.'],
  });
});

test('the last line break is optional', () => {
  assert.deepEqual(parseStarterPhrases('en\tko\nHello.\t안녕하세요.'), { en: ['Hello.'], ko: ['안녕하세요.'] });
});

test('anything that is not a whole table is nothing', () => {
  const cases = [
    ['', 'empty'],
    ['en\tko\n', 'a header and no phrases'],
    ['en\tko\nHello.\n', 'a line with too few columns'],
    ['en\tko\nHello.\t안녕하세요.\textra\n', 'a line with too many columns'],
    ['en\tko\nHello.\t\n', 'an empty phrase'],
    ['en\tko\nHello.\t안녕하세요.\n\n', 'a blank line inside'],
    ['en\t\nHello.\t안녕하세요.\n', 'a column with no code'],
    ['en\ten\nHello.\tHi.\n', 'the same code twice'],
  ];
  for (const [text, why] of cases) assert.equal(parseStarterPhrases(text), null, why);
});

test('the shipped table is whole: eighteen languages, ten phrases each', () => {
  const phrases = readStarterPhrases();
  assert.equal(Object.keys(phrases).length, 18);
  for (const [code, list] of Object.entries(phrases)) assert.equal(list.length, 10, code);
});

test('a missing file is nothing, not a thrown request', () => {
  assert.equal(readStarterPhrases('/nonexistent/starterPhrases.tsv'), null);
});
