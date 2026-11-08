// A clip asked for with no collection picked answers what every other route answers then: the mode,
// and the sentence the page shows for it. It used to hand the whole transport result to
// notReadyResponse, which answered "not available ([object Object])".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER } from '../../server/anki/answer';
import { GET } from '../../server/api/anki/media/[filename]/route';

test('a clip with no profile picked answers 409 unconfigured with the sentence for it', async () => {
  const response = await GET(new Request('http://127.0.0.1/api/anki/media/a.wav'), { params: Promise.resolve({ filename: 'a.wav' }) });
  assert.equal(response.status, 409);
  const body = response[ANSWER];
  assert.equal(body.mode, 'unconfigured');
  assert.equal(body.error, 'No Anki profile is selected yet. Open Settings to pick one.');
});
