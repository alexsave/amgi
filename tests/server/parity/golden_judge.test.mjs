// Golden file: the decision cards.c's card_generate_audio takes before any judge is asked, from its
// pure parts: spokenForm of the card's text, normalizeForComparison of the transcript and of the
// spoken text (by pronunciation for Korean, by NFKC, case, punctuation and spacing for the rest),
// and readingIsAmbiguous (ja and zh, where a reading must be heard when one is given). "accept" is
// a clip taken on its transcript alone; "judge" is one the audio judge must hear. The expected
// answers in tests/server/parity/golden/judge-expected.tsv were produced once from plusaudio's TypeScript
// (by a generator removed at L4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cards, rows } from './golden/cards-tool.mjs';

const golden = rows(fs, 'judge-expected.tsv');

test('each case: the spoken form, both normalised texts, the reading rule and the decision', () => {
  const calls = golden.flatMap(([language, text, transcript]) => [
    ['s', language, text],
    ['n', language, transcript],
    ['a', language, ''],
  ]);
  const got = cards(calls);
  golden.forEach(([language, text, transcript, reading, spoken, heard, said, ambiguous, decision], i) => {
    const [cSpoken, cHeard, cAmbiguous] = got.slice(3 * i, 3 * i + 3);
    const [cSaid] = cards([['n', language, cSpoken]]);
    const what = `${language} ${text} / ${transcript} / ${reading}`;
    assert.equal(cSpoken, spoken, `spoken form: ${what}`);
    assert.equal(cHeard, heard, `transcript normalised: ${what}`);
    assert.equal(cSaid, said, `spoken normalised: ${what}`);
    assert.equal(cAmbiguous, ambiguous, `reading ambiguous: ${what}`);
    const mustHear = cAmbiguous === '1' && reading.trim() !== '';
    assert.equal(cHeard === cSaid && !mustHear ? 'accept' : 'judge', decision, `decision: ${what}`);
  });
});

test('the spread covers both decisions and both reading rules', () => {
  assert.ok(golden.some((r) => r[8] === 'accept') && golden.some((r) => r[8] === 'judge'));
  assert.ok(golden.some((r) => r[7] === '1') && golden.some((r) => r[7] === '0'));
});
