import { existingKeySet, isSectionMarker, normalizeForDedupe, parseLyricsPaste } from '../../utils/lyricsParse';

describe('normalizeForDedupe', () => {
  test('trims and collapses internal whitespace', () => {
    expect(normalizeForDedupe('  hello    world  ')).toBe('hello world');
  });

  test('drops a trailing run of punctuation - the "chorus repeats with a stray comma" case', () => {
    expect(normalizeForDedupe('I will always love you,')).toBe('I will always love you');
    expect(normalizeForDedupe('I will always love you')).toBe('I will always love you');
    expect(normalizeForDedupe('I will always love you...')).toBe('I will always love you');
  });

  test('leaves case exactly alone - no folding', () => {
    expect(normalizeForDedupe('Love')).not.toBe(normalizeForDedupe('love'));
  });

  test('leaves leading punctuation alone', () => {
    expect(normalizeForDedupe('"quoted line"')).toBe('"quoted line');
  });

  test('normalizes Korean lines the same way, punctuation and all', () => {
    expect(normalizeForDedupe('안녕하세요.')).toBe(normalizeForDedupe('안녕하세요'));
  });
});

describe('isSectionMarker', () => {
  test('a pure bracketed line is a marker', () => {
    expect(isSectionMarker('[Chorus]')).toBe(true);
    expect(isSectionMarker('  [Verse 2]  ')).toBe(true);
  });

  test('a line that merely contains brackets is not a marker', () => {
    expect(isSectionMarker('I said [laughs] okay')).toBe(false);
  });

  test('an ordinary line is not a marker', () => {
    expect(isSectionMarker('나는 학생입니다')).toBe(false);
  });
});

describe('parseLyricsPaste', () => {
  test('splits on newlines, trims, and drops blank lines', () => {
    const result = parseLyricsPaste('  first line  \n\n  second line\n   \n');
    expect(result.lines.map((l) => l.text)).toEqual(['first line', 'second line']);
    expect(result.blankCount).toBe(3);
    expect(result.totalLines).toBe(5);
  });

  test('dedupes exact repeats within the paste and counts them', () => {
    const result = parseLyricsPaste('same line\nother line\nsame line\nsame line');
    expect(result.lines.map((l) => l.text)).toEqual(['same line', 'other line']);
    expect(result.lines[0].occurrences).toBe(3);
    expect(result.lines[1].occurrences).toBe(1);
    expect(result.candidateCount).toBe(4);
    expect(result.pasteDuplicateCount).toBe(2);
  });

  test('dedupes near-repeats that only differ by a stray trailing comma', () => {
    const result = parseLyricsPaste('chorus line\nchorus line,\nchorus line.');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].occurrences).toBe(3);
    // The kept text is whichever variant was seen first, unedited - the
    // person can still edit it in the preview before anything is written.
    expect(result.lines[0].text).toBe('chorus line');
  });

  test('does not merge lines that differ only by case', () => {
    const result = parseLyricsPaste('Love\nlove');
    expect(result.lines).toHaveLength(2);
  });

  test('skips bracketed section markers by default', () => {
    const result = parseLyricsPaste('[Verse 1]\nfirst line\n[Chorus]\nsecond line');
    expect(result.lines.map((l) => l.text)).toEqual(['first line', 'second line']);
    expect(result.sectionMarkerCount).toBe(2);
  });

  test('keeps section markers as ordinary candidate lines when the toggle is off', () => {
    const result = parseLyricsPaste('[Verse 1]\nfirst line', { skipSectionMarkers: false });
    expect(result.lines.map((l) => l.text)).toEqual(['[Verse 1]', 'first line']);
    expect(result.sectionMarkerCount).toBe(0);
  });

  test('preserves first-appearance order', () => {
    const result = parseLyricsPaste('c\na\nb\na');
    expect(result.lines.map((l) => l.text)).toEqual(['c', 'a', 'b']);
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
    expect(result.sectionMarkerCount).toBe(3);
    expect(result.blankCount).toBe(1);
    expect(result.lines.map((l) => l.text)).toEqual(['오늘도 걷는다 나는', '아무 말 없이', '사랑해요 사랑해요']);
    expect(result.lines[2].occurrences).toBe(3);
  });
});

describe('existingKeySet', () => {
  test('normalizes deck values the same way pasted lines are normalized', () => {
    const keys = existingKeySet(['Hello there,', 'already here']);
    expect(keys.has(normalizeForDedupe('Hello there'))).toBe(true);
    expect(keys.has(normalizeForDedupe('already here.'))).toBe(true);
    expect(keys.has(normalizeForDedupe('hello there'))).toBe(false);
  });
});
