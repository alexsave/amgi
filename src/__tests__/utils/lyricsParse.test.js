import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existingKeySet, isSectionMarker, normalizeForDedupe, parseLyricsPaste } from '../../utils/lyricsParse.js';

describe('normalizeForDedupe', () => {
  test('trims and collapses internal whitespace', () => {
    assert.equal(normalizeForDedupe('  hello    world  '), 'hello world');
  });

  test('drops a trailing run of punctuation - the "chorus repeats with a stray comma" case', () => {
    assert.equal(normalizeForDedupe('I will always love you,'), 'I will always love you');
    assert.equal(normalizeForDedupe('I will always love you'), 'I will always love you');
    assert.equal(normalizeForDedupe('I will always love you...'), 'I will always love you');
  });

  test('leaves case exactly alone - no folding', () => {
    assert.notEqual(normalizeForDedupe('Love'), normalizeForDedupe('love'));
  });

  test('leaves leading punctuation alone', () => {
    assert.equal(normalizeForDedupe('"quoted line"'), '"quoted line');
  });

  test('normalizes Korean lines the same way, punctuation and all', () => {
    assert.equal(normalizeForDedupe('안녕하세요.'), normalizeForDedupe('안녕하세요'));
  });
});

describe('isSectionMarker', () => {
  test('a pure bracketed line is a marker', () => {
    assert.equal(isSectionMarker('[Chorus]'), true);
    assert.equal(isSectionMarker('  [Verse 2]  '), true);
  });

  test('a line that merely contains brackets is not a marker', () => {
    assert.equal(isSectionMarker('I said [laughs] okay'), false);
  });

  test('an ordinary line is not a marker', () => {
    assert.equal(isSectionMarker('나는 학생입니다'), false);
  });
});

describe('parseLyricsPaste', () => {
  test('splits on newlines, trims, and drops blank lines', () => {
    const result = parseLyricsPaste('  first line  \n\n  second line\n   \n');
    assert.deepEqual(result.lines.map((l) => l.text), ['first line', 'second line']);
    assert.equal(result.blankCount, 3);
    assert.equal(result.totalLines, 5);
  });

  test('dedupes exact repeats within the paste and counts them', () => {
    const result = parseLyricsPaste('same line\nother line\nsame line\nsame line');
    assert.deepEqual(result.lines.map((l) => l.text), ['same line', 'other line']);
    assert.equal(result.lines[0].occurrences, 3);
    assert.equal(result.lines[1].occurrences, 1);
    assert.equal(result.candidateCount, 4);
    assert.equal(result.pasteDuplicateCount, 2);
  });

  test('dedupes near-repeats that only differ by a stray trailing comma', () => {
    const result = parseLyricsPaste('chorus line\nchorus line,\nchorus line.');
    assert.equal((result.lines).length, 1);
    assert.equal(result.lines[0].occurrences, 3);
    // The kept text is whichever variant was seen first, unedited - the
    // person can still edit it in the preview before anything is written.
    assert.equal(result.lines[0].text, 'chorus line');
  });

  test('does not merge lines that differ only by case', () => {
    const result = parseLyricsPaste('Love\nlove');
    assert.equal((result.lines).length, 2);
  });

  test('skips bracketed section markers by default', () => {
    const result = parseLyricsPaste('[Verse 1]\nfirst line\n[Chorus]\nsecond line');
    assert.deepEqual(result.lines.map((l) => l.text), ['first line', 'second line']);
    assert.equal(result.sectionMarkerCount, 2);
  });

  test('keeps section markers as ordinary candidate lines when the toggle is off', () => {
    const result = parseLyricsPaste('[Verse 1]\nfirst line', { skipSectionMarkers: false });
    assert.deepEqual(result.lines.map((l) => l.text), ['[Verse 1]', 'first line']);
    assert.equal(result.sectionMarkerCount, 0);
  });

  test('preserves first-appearance order', () => {
    const result = parseLyricsPaste('c\na\nb\na');
    assert.deepEqual(result.lines.map((l) => l.text), ['c', 'a', 'b']);
  });

  test('real Korean lyric-shaped input, repeats and a section marker together', () => {
    const pasted = [
      '[Verse 1]',
      '오늘도 걷는다 나는',
      '아무 말 없이',
      '',
      '[Chorus]',
      '사랑해요 사랑해요',
      '사랑해요 사랑해요,',
      '[Chorus]',
      '사랑해요 사랑해요',
    ].join('\n');
    const result = parseLyricsPaste(pasted);
    assert.equal(result.sectionMarkerCount, 3);
    assert.equal(result.blankCount, 1);
    assert.deepEqual(result.lines.map((l) => l.text), ['오늘도 걷는다 나는', '아무 말 없이', '사랑해요 사랑해요']);
    assert.equal(result.lines[2].occurrences, 3);
  });
});

describe('existingKeySet', () => {
  test('normalizes deck values the same way pasted lines are normalized', () => {
    const keys = existingKeySet(['Hello there,', 'already here']);
    assert.equal(keys.has(normalizeForDedupe('Hello there')), true);
    assert.equal(keys.has(normalizeForDedupe('already here.')), true);
    assert.equal(keys.has(normalizeForDedupe('hello there')), false);
  });
});
