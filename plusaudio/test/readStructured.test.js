'use strict';

// What counts as a usable structured answer from the model (cardGeneration.ts's
// readStructured): the service is asked for the schema, but the answer is
// still the model's text, and a card is only made from one that is checked.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { GENERATED_CARD_FORMAT, readStructured } = require('../lib/cardGeneration/cardGeneration.ts');

const CARD = { known_text: 'date', learning_text: '날짜', sense_tag: 'calendar day', register: 'casual', spoken_reading: '' };
const read = (value) => readStructured(typeof value === 'string' ? value : JSON.stringify(value), GENERATED_CARD_FORMAT);

test('every field typed as declared is the answer, an undeclared extra dropped', () => {
  assert.deepEqual(read({ ...CARD, extra: 'x' }), { ok: true, fields: CARD });
});

test('each way an answer can be unusable says what was wrong', () => {
  const cases = [
    ['', 'no answer'],
    ['known: date', 'not JSON: "known: date"'],
    [[CARD], 'not an object: a list'],
    ['null', 'not an object: null'],
    ['"date"', 'not an object: a string'],
    [{ ...CARD, spoken_reading: undefined }, 'spoken_reading is missing'],
    [{ ...CARD, sense_tag: null }, 'sense_tag is missing'],
    [{}, 'known_text is missing'],
    [{ ...CARD, learning_text: 7 }, 'learning_text is a number, not a string'],
    [{ ...CARD, known_text: ['a', 'b'] }, 'known_text is a list, not a string'],
    [{ ...CARD, register: 'Polite' }, 'register is "Polite", not one of casual, polite, formal'],
    [{ ...CARD, register: 'neutral' }, 'register is "neutral", not one of casual, polite, formal'],
    [{ ...CARD, register: '' }, 'register is "", not one of casual, polite, formal'],
    ['{"toString":"x"}', 'known_text is missing'],
  ];
  for (const [given, detail] of cases) assert.deepEqual(read(given), { ok: false, detail }, detail);
});

test('every register the schema allows is taken', () => {
  for (const register of ['casual', 'polite', 'formal']) assert.equal(read({ ...CARD, register }).ok, true, register);
});
