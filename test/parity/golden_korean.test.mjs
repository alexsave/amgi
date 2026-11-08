// Golden file: cards.c's Korean pronunciation-aware comparison (koreanPronunciation and
// normalizeForComparison for 'ko'), which decides whether a clip's transcript says the card's
// Korean. The expected answers in test/parity/golden/korean-expected.tsv were produced once from
// plusaudio's TypeScript (by a generator removed at L4) and are now the contract: liaison
// (음악이 [으마기]), palatalisation (같이 [가치]), the ㅎ rules (좋다 [조타], 좋아요 [조아요], 축하 [추카]),
// coda neutralisation (부엌 [부억]), nasalisation (국물 [궁물]), lateralisation (신라 [실라]),
// tensification (학교 [학꾜]), and the homophones 역이/여기 that this comparison exists for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cards, rows } from './golden/cards-tool.mjs';

const golden = rows(fs, 'korean-expected.tsv');

test('the golden file holds at least 60 cases', () => {
  assert.ok(golden.length >= 60, String(golden.length));
});

test('koreanPronunciation answers the golden file, case for case', () => {
  const got = cards(golden.map(([text]) => ['k', 'ko', text]));
  golden.forEach(([text, want], i) => assert.equal(got[i], want, text));
});

test('normalizeForComparison (ko) answers the golden file, case for case', () => {
  const got = cards(golden.map(([text]) => ['n', 'ko', text]));
  golden.forEach(([text, , want], i) => assert.equal(got[i], want, text));
});

test('역이 and 여기 compare equal, as Korean speech says them', () => {
  const [a, b] = cards([['n', 'ko', '역이 어디예요?'], ['n', 'ko', '여기 어디예요']]);
  assert.equal(a, b);
});
