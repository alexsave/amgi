/**
 * @jest-environment node
 */

// What /api/anki/card-text answers about Gemini's limits: a 429 with the
// rate gate's own wait (body and Retry-After) when a started card hit a
// per-minute limit, a 429 marked dailyCap when the day is spent, and - while
// the gate says a model is blocked - a 429 before anything starts, with no
// generator run at all.

jest.mock('../../server/anki/settings', () => ({ readSettings: () => ({}) }));
jest.mock('../../server/anki/transport', () => ({ resolveTransport: async () => ({ mode: 'direct', ops: {} }) }));
jest.mock('../../server/anki/cardText', () => ({ generateCardTextAndAudio: jest.fn() }));

import { POST } from '../../app/api/anki/card-text/route';
import { generateCardTextAndAudio } from '../../server/anki/cardText';
import { DailyCapError, RateLimitedError } from '../../server/anki/plusaudioCli';
import { sharedGate } from 'plusaudio/lib/rateGate';

const post = () => POST(new Request('http://localhost/api/anki/card-text', {
  method: 'POST',
  body: JSON.stringify({ userInput: 'Where is the station?', knownLanguage: 'en', learningLanguage: 'ko' }),
}));

// Each test that needs the gate open uses a model name no other test blocked;
// the gate is the server's one instance, exactly as the route sees it.
beforeEach(() => generateCardTextAndAudio.mockReset());

test('a started card that hit a per-minute limit answers 429 with the wait in the body and Retry-After', async () => {
  generateCardTextAndAudio.mockRejectedValue(new RateLimitedError('Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.', 51200));

  const response = await post();

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('52');
  expect(await response.json()).toEqual({
    error: 'Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.',
    retryAfterMs: 51200,
  });
});

test('a spent daily cap answers 429 marked dailyCap, with no retry time', async () => {
  generateCardTextAndAudio.mockRejectedValue(new DailyCapError("Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up."));

  const response = await post();

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeNull();
  expect(await response.json()).toEqual({ error: "Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up.", dailyCap: true });
});

test('any other failure is still a 500 with its message', async () => {
  generateCardTextAndAudio.mockRejectedValue(new Error('Failed to generate valid audio for "x" after 3 attempts'));
  const response = await post();
  expect(response.status).toBe(500);
  expect((await response.json()).error).toMatch(/after 3 attempts/);
});

test('while the gate says a model is blocked, a new card is refused before it starts: no generator, no Gemini call', async () => {
  sharedGate().record('route-test-model', 'rateLimited', 40_000);

  const response = await post();

  expect(response.status).toBe(429);
  const body = await response.json();
  expect(body.notStarted).toBe(true);
  expect(body.retryAfterMs).toBeGreaterThanOrEqual(39_000);
  expect(Number(response.headers.get('Retry-After'))).toBe(Math.ceil(body.retryAfterMs / 1000));
  expect(generateCardTextAndAudio).not.toHaveBeenCalled();
});
