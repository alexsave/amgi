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

test('a clip name that is not a valid percent-encoding answers 400 with a sentence, not 500', async () => {
  for (const raw of ['%E0%A4%A', '%', 'a%zz.wav']) {
    const response = await GET(new Request(`http://127.0.0.1/api/anki/media/${raw}`), { params: Promise.resolve({ filename: raw }) });
    assert.equal(response.status, 400, raw);
    assert.equal(response[ANSWER].error, 'the clip name is not a valid name');
  }
});

test('a clip name is decoded once, by the route: an encoded name reaches the transport as the name', async () => {
  // With no profile picked the transport answers 409; a 409 (not a 400) means the name decoded.
  const response = await GET(new Request('http://127.0.0.1/api/anki/media/%ED%95%9C.wav'), { params: Promise.resolve({ filename: '%ED%95%9C.wav' }) });
  assert.equal(response.status, 409);
});
