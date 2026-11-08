'use strict';

// lib/cardTextLayout.js: the bytes generate-card-text.js prints a card in,
// and the one reader of them. Written and read back both ways, any text
// intact, and the reader strict on anything that is not exactly the layout.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { readCardText, writeCardText } = require('../lib/cardTextLayout');

const CARD = { front_text: 'Where is the station?', back_text: '역이 어디예요?', spoken_reading: '' };

test('a card is written as a header, then each field as its name and byte length, then its bytes', () => {
  assert.equal(writeCardText(CARD).toString('utf8'),
    'amgi-card-text 1\nfront_text 21\nWhere is the station?\nback_text 20\n역이 어디예요?\nspoken_reading 0\n\n');
});

test('what is written reads back the same, whatever the text holds', () => {
  const cards = [
    CARD,
    { front_text: 'two\nlines', back_text: 'a "quote" and a \\ and a tab\t', spoken_reading: 'いった' },
    { front_text: 'front_text 3\nabc', back_text: '\n\n', spoken_reading: 'amgi-card-text 1\n' },
    { front_text: '😀 emoji', back_text: '', spoken_reading: '' },
  ];
  for (const card of cards) {
    assert.deepEqual(readCardText(writeCardText(card)), card);
    assert.deepEqual(readCardText(writeCardText(card).toString('utf8')), card, 'and as the string the server collects');
  }
});

test('a missing field is written empty; a field that is not a string is refused', () => {
  assert.deepEqual(readCardText(writeCardText({ front_text: 'a', back_text: 'b' })), { front_text: 'a', back_text: 'b', spoken_reading: '' });
  assert.throws(() => writeCardText({ ...CARD, back_text: 7 }), /back_text is not a string/);
});

test('the reader refuses anything that is not exactly the layout', () => {
  const good = writeCardText(CARD).toString('utf8');
  const cases = [
    ['', /ends in the middle of a line/],
    ['{"front_text":"a","back_text":"b","spoken_reading":""}\n', /does not start with "amgi-card-text 1"/],
    [good.replace('amgi-card-text 1', 'amgi-card-text 2'), /does not start with/],
    [good.replace('front_text 21', 'back_text 21'), /front_text was expected next/],
    [good.replace('front_text 21', 'front_text 22'), /front_text is not 22 bytes/],
    [good.replace('front_text 21', 'front_text 20'), /front_text is not 20 bytes/],
    [good.replace('front_text 21', 'front_text 021'), /front_text was expected next/],
    [good.replace('front_text 21', 'front_text -1'), /front_text was expected next/],
    [good.slice(0, good.indexOf('spoken_reading')), /ends in the middle of a line/],
    [good.slice(0, -1), /spoken_reading is not 0 bytes/],
    [`${good}extra`, /more output after the last field/],
  ];
  for (const [output, error] of cases) assert.throws(() => readCardText(output), error, JSON.stringify(output.slice(0, 40)));
});
