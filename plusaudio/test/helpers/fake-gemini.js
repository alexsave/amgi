'use strict';

// A fake of Google's GenerateContent gRPC service for tests: no key, no
// network. It is a real gRPC server - cleartext HTTP/2 on 127.0.0.1, an
// ephemeral port - so the client under test runs its whole transport (the
// connection, framing, trailers, status details) exactly as it does against
// generativelanguage.googleapis.com, and only the far end is ours.
//
// Every model call amgi makes goes through cardGeneration/gemini.ts's one
// client, and this fake tells the four kinds of request apart the way the
// real service would see them:
//
//   speech      generationConfig.responseModalities includes "AUDIO"
//   judge       an inlineData audio part AND a responseJsonSchema
//   transcribe  an inlineData audio part, no schema
//   text        a responseJsonSchema and no audio (card text, and the
//               transcript fallback judge, whose schema has only `matches`)
//
// Each kind answers from the script passed in; anything unscripted fails the
// way an outage would (UNAVAILABLE), which is what the fallback paths are for.
//
// Run directly, it is the e2e fake server: `node plusaudio/test/helpers/fake-gemini.js [port]`
// prints the GEMINI_API_BASE to point the app or a CLI at, and answers every
// kind with a passing default.

const http2 = require('node:http2');

const { pcmToWav } = require('../../lib/cardGeneration/geminiSpeech.ts');
const {
  GENERATE_CONTENT_PATH,
  GenerateContentRequest,
  GenerateContentResponse,
  decode,
  encode,
  encodeStatus,
  frame,
  unframe,
} = require('../../lib/cardGeneration/geminiWire.ts');

const WAV = Buffer.from(pcmToWav(new Uint8Array(8), 24000, 1));

const UNAVAILABLE = 14;
const RESOURCE_EXHAUSTED = 8;

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

/** A successful answer: a GenerateContentResponse object, encoded as protobuf by the server. */
const answer = (response) => ({ raw: true, response });
const textAnswer = (text) => answer({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] });
const wavAnswer = (bytes = WAV, mimeType = 'audio/wav') =>
  answer({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ inlineData: { mimeType, data: new Uint8Array(bytes) } }] } }] });
/** A gRPC error: a status code, its message and google.rpc details ({type: 'QuotaFailure' | 'RetryInfo' | 'ErrorInfo', value}). */
const grpcError = (code, message = '', details = []) => ({ raw: true, error: { code, message, details } });
const outage = () => grpcError(UNAVAILABLE, 'unscripted (fake outage)');

/** A quota refusal exactly as Gemini sends it over gRPC: RESOURCE_EXHAUSTED with a QuotaFailure and, given a delay, a RetryInfo. */
function quotaExhausted(violation, retryDelaySeconds) {
  const details = [{ type: 'QuotaFailure', value: { violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests', ...violation }] } }];
  if (retryDelaySeconds !== undefined) {
    const seconds = Math.floor(retryDelaySeconds);
    const nanos = Math.round((retryDelaySeconds - seconds) * 1e9);
    details.push({ type: 'RetryInfo', value: { retryDelay: { seconds, ...(nanos ? { nanos } : {}) } } });
  }
  return grpcError(RESOURCE_EXHAUSTED, 'You exceeded your current quota.', details);
}

/** A per-day free-tier refusal. */
function dailyQuotaExhausted() {
  return quotaExhausted({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }, 20000);
}

function respond(stream, entry) {
  if (entry.hang) return; // never answers: for the client's own timeout
  if (entry.httpStatus) {
    // Not a gRPC answer at all, the way a proxy or a wrong endpoint replies.
    stream.respond({ ':status': entry.httpStatus, 'content-type': 'text/plain' });
    stream.end(entry.body || '');
    return;
  }
  if (entry.error) {
    // Trailers-only, as every gRPC error is sent.
    const { code, message, details } = entry.error;
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc',
      'grpc-status': String(code),
      ...(message ? { 'grpc-message': encodeURIComponent(message) } : {}),
      ...(details && details.length ? { 'grpc-status-details-bin': encodeStatus({ code, message, details }) } : {}),
    }, { endStream: true });
    return;
  }
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
  stream.end(frame(encode(GenerateContentResponse, entry.response)));
}

/**
 * Starts the fake. Resolves once it listens.
 *
 * @param {object} script  per kind: a value, or a function (body, index) => value, where value is
 *   speech: a raw answer (default: a WAV answer)
 *   transcribe: the transcript string
 *   judge: {heard, matches, reason}
 *   text: card fields object, or an array of them taken in order
 *   transcriptJudge: {matches}
 *   Any kind may instead give a raw answer: answer(response), grpcError(...), quotaExhausted(...),
 *   {raw: true, httpStatus, body} for a non-gRPC reply, or {raw: true, hang: true} for none.
 * @param {object} [options]
 * @param {number} [options.port]  0 (an ephemeral port) unless the e2e fake asks for a fixed one
 * @returns {Promise<{baseUrl: string, requests: object[], of: function, close: function}>}
 */
async function fakeGemini(script = {}, { port = 0 } = {}) {
  const requests = [];
  const counts = {};
  const server = http2.createServer();
  // Neither the listener nor a connection keeps a test process alive.
  const sessions = new Set();
  server.on('session', (session) => {
    session.unref();
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      if (headers[':path'] !== GENERATE_CONTENT_PATH) {
        respond(stream, grpcError(12, `unknown method ${headers[':path']}`));
        return;
      }
      const [message] = unframe(Buffer.concat(chunks));
      const { model: name = '', ...body } = decode(GenerateContentRequest, message);
      const kind = kindOf(body);
      const index = counts[kind] || 0;
      counts[kind] = index + 1;
      const model = name.replace(/^models\//, '');
      requests.push({ path: headers[':path'], model, kind, body, headers, bytes: message.length });

      let entry = script[kind];
      if (typeof entry === 'function') entry = entry(body, index);
      if (Array.isArray(entry)) entry = entry[Math.min(index, entry.length - 1)];

      let reply;
      if (entry && entry.raw) reply = entry;
      else if (kind === 'speech') reply = entry || wavAnswer();
      else if (entry === undefined) reply = outage();
      else if (kind === 'transcribe') reply = textAnswer(String(entry));
      else reply = textAnswer(JSON.stringify(entry));
      respond(stream, reply);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  server.unref();
  const of = (kind) => requests.filter((request) => request.kind === kind);
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    for (const session of sessions) session.destroy();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, of, close, server };
}

module.exports = { WAV, answer, dailyQuotaExhausted, fakeGemini, grpcError, kindOf, quotaExhausted, textAnswer, wavAnswer };

if (require.main === module) {
  // The e2e fake: every kind passes, so a whole card goes through.
  const script = {
    text: { known_text: 'Where is the station?', learning_text: '역이 어디예요?', sense_tag: '', register: 'polite', spoken_reading: '' },
    transcribe: '',
    judge: { heard: '', matches: true, reason: 'fake server' },
    transcriptJudge: { matches: true },
  };
  fakeGemini(script, { port: Number(process.argv[2] || 0) }).then(({ baseUrl, server }) => {
    server.ref();
    console.log(`GEMINI_API_BASE=${baseUrl}`);
  });
}
