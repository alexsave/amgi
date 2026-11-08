// GET /decks/:id/notes/field-values reads one field of every note of one type in a deck: both of
// its query parameters are required whole numbers. A missing or non-numeric one is the caller's
// mistake, answered 400 with a sentence naming it, before any collection is opened (it used to read
// as 0 and answer 200 with no values).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER } from '../../server/anki/answer';
import { GET } from '../../server/api/anki/decks/[id]/notes/field-values/route';

const ask = (query) => GET(new Request(`http://127.0.0.1/api/anki/decks/5/notes/field-values${query}`), { params: Promise.resolve({ id: '5' }) });

test('a missing or non-numeric notetypeId or fieldIndex answers 400 naming it', async () => {
  const cases = [
    ['', 'notetypeId and fieldIndex must be given, as a whole number'],
    ['?fieldIndex=1', 'notetypeId must be given, as a whole number'],
    ['?notetypeId=7', 'fieldIndex must be given, as a whole number'],
    ['?notetypeId=abc&fieldIndex=1', 'notetypeId must be given, as a whole number'],
    ['?notetypeId=7&fieldIndex=', 'fieldIndex must be given, as a whole number'],
    ['?notetypeId=7&fieldIndex=1.5', 'fieldIndex must be given, as a whole number'],
    ['?notetypeId=-7&fieldIndex=1', 'notetypeId must be given, as a whole number'],
  ];
  for (const [query, error] of cases) {
    const response = await ask(query);
    assert.equal(response.status, 400, query);
    assert.equal(response[ANSWER].error, error, query);
  }
});

test('whole numbers go on to the collection (here: none picked, so 409)', async () => {
  const response = await ask('?notetypeId=1794095498266&fieldIndex=0');
  assert.equal(response.status, 409);
  assert.equal(response[ANSWER].mode, 'unconfigured');
});
