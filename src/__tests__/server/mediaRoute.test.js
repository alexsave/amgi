/**
 * @jest-environment node
 */
// A clip asked for with no collection picked answers what every other route answers then: the mode,
// and the sentence the page shows for it. It used to hand the whole transport result to
// notReadyResponse, which answered "not available ([object Object])".
import { GET } from '../../app/api/anki/media/[filename]/route';

test('a clip with no profile picked answers 409 unconfigured with the sentence for it', async () => {
  const response = await GET(new Request('http://127.0.0.1/api/anki/media/a.wav'), { params: Promise.resolve({ filename: 'a.wav' }) });
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.mode).toBe('unconfigured');
  expect(body.error).toBe('No Anki profile is selected yet. Open Settings to pick one.');
});
