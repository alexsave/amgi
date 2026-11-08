// What /api/anki/card-text answers about Gemini's limits: a 429 with the
// rate gate's own wait (body and Retry-After) when a started card hit a
// per-minute limit, a 429 marked dailyCap when the day is spent, and - while
// the gate says a model is blocked - a 429 before anything starts, with no
// generator run at all.

import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER } from '../../server/anki/answer';
import { DailyCapError, RateLimitedError } from '../../server/anki/plusaudioCli';
import { sharedGate } from 'plusaudio/lib/rateGate';
import { MAX_WAIT_MS } from 'plusaudio/lib/rateLimits';

// The route's own neighbours, faked where it imports them (run with --experimental-test-module-mocks).
const at = (file) => new URL(`../../server/anki/${file}.js`, import.meta.url).href;
const generateCardTextAndAudio = mock.fn();
mock.module(at('settings'), { namedExports: { readSettings: () => ({}) } });
mock.module(at('transport'), { namedExports: { resolveTransport: async () => ({ mode: 'direct', ops: {} }) } });
mock.module(at('cardText'), { namedExports: { generateCardTextAndAudio } });
const { POST } = await import('../../server/api/anki/card-text/route');

const post = () => POST(new Request('http://localhost/api/anki/card-text', {
  method: 'POST',
  body: JSON.stringify({ userInput: 'Where is the station?', knownLanguage: 'en', learningLanguage: 'ko' }),
}));

// Each test that needs the gate open uses a model name no other test blocked;
// the gate is the server's one instance, exactly as the route sees it.
beforeEach(() => generateCardTextAndAudio.mock.resetCalls());

test('a started card that hit a per-minute limit answers 429 with the wait in the body and Retry-After', async () => {
  generateCardTextAndAudio.mock.mockImplementation(async () => { throw new RateLimitedError('Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.', 51200); });

  const response = await post();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '52');
  assert.deepEqual(response[ANSWER], {
    error: 'Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.',
    retryAfterMs: 51200,
    maxWaitMs: MAX_WAIT_MS,
  });
});

test('a spent daily cap answers 429 marked dailyCap, with no retry time', async () => {
  generateCardTextAndAudio.mock.mockImplementation(async () => { throw new DailyCapError("Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up."); });

  const response = await post();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), null);
  assert.deepEqual(response[ANSWER], { error: "Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up.", dailyCap: true });
});

test('any other failure is still a 500 with its message', async () => {
  generateCardTextAndAudio.mock.mockImplementation(async () => { throw new Error('Failed to generate valid audio for "x" after 3 attempts'); });
  const response = await post();
  assert.equal(response.status, 500);
  assert.match((response[ANSWER]).error, /after 3 attempts/);
});

test('while the gate says a model is blocked, a new card is refused before it starts: no generator, no Gemini call', async () => {
  sharedGate().record('route-test-model', 'rateLimited', 40_000);

  const response = await post();

  assert.equal(response.status, 429);
  const body = response[ANSWER];
  assert.equal(body.notStarted, true);
  assert.ok((body.retryAfterMs) >= 39_000);
  assert.equal(Number(response.headers.get('Retry-After')), Math.ceil(body.retryAfterMs / 1000));
  assert.equal((generateCardTextAndAudio).mock.callCount(), 0);
});
