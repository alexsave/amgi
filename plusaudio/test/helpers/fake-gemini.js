'use strict';

// A fake of Google's generateContent endpoint for tests: no key, no network.
//
// Every model call amgi makes goes through cardGeneration/gemini.ts's one
// client, so the tests fake the one thing under it - fetch - and tell the
// four kinds of request apart the way the real API would see them:
//
//   speech      generationConfig.responseModalities includes "AUDIO"
//   judge       an inlineData audio part AND a responseJsonSchema
//   transcribe  an inlineData audio part, no schema
//   text        a responseJsonSchema and no audio (card text, and the
//               transcript fallback judge, whose schema has only `matches`)
//
// Each kind answers from the script passed in; anything unscripted fails the
// way an outage would (HTTP 503), which is what the fallback paths are for.

const { pcmToWav } = require('../../lib/cardGeneration/geminiSpeech.ts');

const WAV = Buffer.from(pcmToWav(new Uint8Array(8), 24000, 1));

function kindOf(body) {
  const config = body.generationConfig || {};
  if ((config.responseModalities || []).includes('AUDIO')) return 'speech';
  const parts = (body.contents || []).flatMap((content) => content.parts || []);
  const hasAudio = parts.some((part) => part.inlineData);
  if (hasAudio && config.responseJsonSchema) return 'judge';
  if (hasAudio) return 'transcribe';
  if (config.responseJsonSchema) {
    const properties = Object.keys(config.responseJsonSchema.properties || {});
    return properties.length === 1 && properties[0] === 'matches' ? 'transcriptJudge' : 'text';
  }
  return 'unknown';
}

const ok = (body) => ({ status: 200, body });
const textAnswer = (text) => ok({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
const wavAnswer = (bytes = WAV) => ok({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(bytes).toString('base64') } }] } }] });
const outage = () => ({ status: 503, body: { error: { code: 503, message: 'unscripted (fake outage)' } } });

/**
 * @param {object} script  per kind: a value, or a function (body, index) => value, where value is
 *   speech: a {status, body} response (default: a WAV answer)
 *   transcribe: the transcript string
 *   judge: {heard, matches, reason}
 *   text: card fields object, or an array of them taken in order
 *   transcriptJudge: {matches}
 *   Any kind may instead give a raw {status, body} via `raw: true` in the object.
 */
function fakeGemini(script = {}) {
  const requests = [];
  const counts = {};
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const kind = kindOf(body);
    const index = counts[kind] || 0;
    counts[kind] = index + 1;
    const model = decodeURIComponent(/\/models\/([^:]+):generateContent$/.exec(url)?.[1] || '');
    requests.push({ url, model, kind, body, headers: init.headers });

    let entry = script[kind];
    if (typeof entry === 'function') entry = entry(body, index);
    if (Array.isArray(entry)) entry = entry[Math.min(index, entry.length - 1)];

    let response;
    if (entry && entry.raw) response = entry;
    else if (kind === 'speech') response = entry || wavAnswer();
    else if (entry === undefined) response = outage();
    else if (kind === 'transcribe') response = textAnswer(String(entry));
    else response = textAnswer(JSON.stringify(entry));

    const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => text };
  };
  const of = (kind) => requests.filter((request) => request.kind === kind);
  return { fetch, requests, of };
}

/** A per-day free-tier 429, exactly as Gemini sends it. */
function dailyQuota429() {
  return {
    raw: true,
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20000s' },
    ] } },
  };
}

module.exports = { WAV, dailyQuota429, fakeGemini, kindOf, wavAnswer };
