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
// Run directly, it is the e2e fake server: `node tests/server/plusaudio/helpers/fake-gemini.js [port]`
// prints the GEMINI_API_BASE to point the app or a CLI at, and answers every
// kind with a passing default.

const crypto = require('node:crypto');
const http2 = require('node:http2');

const { pcmToWav } = require('../../../../plusaudio/lib/cardGeneration/geminiSpeech.ts');
const {
  GENERATE_CONTENT_PATH,
  GenerateContentRequest,
  GenerateContentResponse,
  decode,
  encode,
  encodeStatus,
  frame,
  unframe,
} = require('../../../../plusaudio/lib/cardGeneration/geminiWire.ts');

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
 * @param {function} [options.control]  answers POST /control: called with its query's URLSearchParams
 * @returns {Promise<{baseUrl: string, requests: object[], of: function, close: function}>}
 */
async function fakeGemini(script = {}, { port = 0, control } = {}) {
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
      if (control && headers[':path'].startsWith('/control')) {
        control(new URL(headers[':path'], 'http://fake').searchParams);
        stream.respond({ ':status': 204 });
        stream.end();
        return;
      }
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
      if (typeof entry === 'function') entry = entry(body, index, model);
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

/**
 * The e2e fake's script: every kind passes, as a person's card would, with the limits a run of
 * cards meets switchable while it serves (state, changed by control):
 *   text        known = the line typed ("Their input"), learning = a Korean sentence numbered from it
 *   speech      a tone unique to its text; refused per minute past state.perMinute per model, with
 *               the RetryInfo of the oldest request's minute
 *   transcribe  the text whose tone it hears, so every clip passes
 *   judge       matches
 *   state.daily: every text call refused for the day; the line "broken line" fails its first call.
 */
function e2eScript(state = { perMinute: Infinity, daily: false }, now = () => Date.now()) {
  const windows = new Map();
  const spoken = [];
  let broken = false;
  const tone = (said) => {
    const rate = 24000;
    const pcm = new Int16Array(rate / 2);
    const freq = 200 + (crypto.createHash('sha1').update(said).digest()[0] % 200);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * freq * i) / rate));
    const bytes = Buffer.from(pcmToWav(new Uint8Array(pcm.buffer), rate, 1));
    spoken.push({ needle: bytes.subarray(44 + 2 * freq, 44 + 2 * freq + 64), said });
    return bytes;
  };
  const textOf = (body) => (body.contents || []).flatMap((c) => c.parts || []).map((p) => p.text || '').join('\n');
  const heard = (body) => {
    const audio = (body.contents || []).flatMap((c) => c.parts || []).find((p) => p.inlineData);
    const bytes = Buffer.from(audio.inlineData.data);
    return spoken.find((s) => bytes.includes(s.needle))?.said ?? '';
  };
  return {
    state,
    text: (body) => {
      if (state.daily) return dailyQuotaExhausted();
      const input = (/Their input: "([^"\n]+)"/.exec(textOf(body)) || [])[1] || 'line';
      if (input === 'broken line' && !broken) {
        broken = true;
        return grpcError(13, 'The model is overloaded. Please try again later.');
      }
      const number = (input.match(/\d+/) || [String(input.length)])[0];
      return { known_text: input, learning_text: `${number}번 문장이에요.`, sense_tag: '', register: 'polite', spoken_reading: '' };
    },
    speech: (body, index, model) => {
      const t = now();
      const starts = (windows.get(model) || []).filter((s) => t - s < 60_000);
      windows.set(model, starts);
      if (starts.length >= state.perMinute) {
        return quotaExhausted({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', quotaValue: state.perMinute },
          (starts[0] + 60_000 - t) / 1000);
      }
      starts.push(t);
      return wavAnswer(tone(textOf(body)));
    },
    transcribe: (body) => heard(body),
    judge: (body) => ({ heard: heard(body), matches: true, reason: 'fake server' }),
    transcriptJudge: { matches: true },
    /** POST /control?perMinute=N&daily=0|1: the limits from now on; the minute's count starts again. */
    control(params) {
      if (params.has('perMinute')) state.perMinute = Number(params.get('perMinute'));
      if (params.has('daily')) state.daily = params.get('daily') === '1';
      windows.clear();
    },
  };
}

/** POST /control on a running fake (it speaks HTTP/2 only), resolved once it answered. */
function controlFake(baseUrl, query) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(baseUrl);
    session.on('error', reject);
    const request = session.request({ ':method': 'POST', ':path': `/control?${query}` });
    request.on('response', () => {});
    request.on('end', () => {
      session.close();
      resolve();
    });
    request.on('error', reject);
    request.resume();
    request.end();
  });
}

module.exports = { WAV, answer, controlFake, dailyQuotaExhausted, e2eScript, fakeGemini, grpcError, kindOf, quotaExhausted, textAnswer, wavAnswer };

if (require.main === module) {
  // The e2e fake: every kind passes, so whole cards go through; its limits switch through /control.
  const script = e2eScript();
  fakeGemini(script, { port: Number(process.argv[2] || 0), control: script.control }).then(({ baseUrl, server }) => {
    server.ref();
    console.log(`GEMINI_API_BASE=${baseUrl}`);
  });
}
