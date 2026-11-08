'use strict';

// The wire under the Gemini client: geminiWire.ts's protobuf messages, and
// gemini.ts's gRPC transport over node:http2.
//
// The fake server (helpers/fake-gemini.js) encodes and decodes with the same
// descriptors the client does, so a wrong field number there would pass every
// other test - both ends would agree on the wrong thing. The golden tests
// here pin the layout instead to bytes built by hand from ../lib/protobuf.js's
// primitives, with the field numbers the live service accepted and sent on
// 2026-11-08 (see geminiWire.ts's header).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');

const { writeBytesField, writeDoubleField, writeVarint, writeVarintField } = require('../lib/protobuf');
const {
  GenerateContentRequest,
  GenerateContentResponse,
  decode,
  decodeValue,
  encode,
  encodeStatus,
  encodeValue,
  statusDetails,
} = require('../lib/cardGeneration/geminiWire.ts');
const { GeminiUnavailableError, createGeminiClient } = require('../lib/cardGeneration/gemini.ts');
const { GENERATED_CARD_FORMAT } = require('../lib/cardGeneration/cardGeneration.ts');
const { createRateGate } = require('../lib/rateGate');
const { createRandom } = require('../lib/random');
const { fakeGemini, grpcError, textAnswer, wavAnswer, WAV } = require('./helpers/fake-gemini');

const str = (n, text) => writeBytesField(n, Buffer.from(text, 'utf8'));
const msg = (n, ...fields) => writeBytesField(n, Buffer.concat(fields));

function clientFor(baseUrl, options = {}) {
  const clock = { t: 1_000_000 };
  return createGeminiClient({
    apiKey: 'test-key',
    baseUrl,
    gate: createRateGate({ now: () => clock.t, random: createRandom(5) }),
    sleep: async (ms) => { clock.t += ms; },
    ...options,
  });
}

test('a speech request is laid out with the field numbers the live service accepted', () => {
  const bytes = encode(GenerateContentRequest, {
    model: 'models/gemini-3.8-flash-lite-tts',
    contents: [{ parts: [{ text: '역이 어디예요?' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  });

  const expected = Buffer.concat([
    str(1, 'models/gemini-3.8-flash-lite-tts'),
    msg(2, msg(1, str(2, '역이 어디예요?'))),
    msg(4,
      writeBytesField(20, writeVarint(3)), // response_modalities, packed: [AUDIO]
      msg(21, msg(1, msg(1, str(1, 'Kore'))))), // speech_config.voice_config.prebuilt_voice_config.voice_name
  ]);
  assert.equal(bytes.toString('hex'), expected.toString('hex'));
});

test('a structured request carries its system prompt, role, schema and thinking level in their own fields', () => {
  const bytes = encode(GenerateContentRequest, {
    model: 'models/gemini-3.8-flash',
    systemInstruction: { parts: [{ text: 'sys' }] },
    contents: [{ role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'audio/wav', data: new Uint8Array([1, 2, 3]) } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
      thinkingConfig: { thinkingLevel: 'LOW' },
    },
  });

  const expected = Buffer.concat([
    str(1, 'models/gemini-3.8-flash'),
    msg(2, msg(1, str(2, 'hi')), msg(1, msg(3, str(1, 'audio/wav'), writeBytesField(2, Buffer.from([1, 2, 3])))), str(2, 'user')),
    msg(4,
      str(13, 'application/json'),
      // response_json_schema (28) is a google.protobuf.Value: struct_value (5)
      // holding one map entry {key 1, value 2}, the value a string_value (3).
      msg(22, writeVarintField(4, 1)), // thinking_config.thinking_level = LOW
      msg(28, msg(5, msg(1, str(1, 'type'), msg(2, str(3, 'object')))))),
    msg(8, msg(1, str(2, 'sys'))), // system_instruction
  ]);
  assert.equal(bytes.toString('hex'), expected.toString('hex'));
});

test('a response laid out as the live service sends it decodes to the shape the callers read, unknown fields skipped', () => {
  const thoughtSignature = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const wire = Buffer.concat([
    msg(1, // candidates
      msg(1, msg(1, str(2, 'thinking...'), writeVarintField(11, 1)), msg(1, str(2, '{"a":1}'), writeBytesField(13, thoughtSignature)), str(2, 'model')),
      writeVarintField(2, 1), // finish_reason STOP
      writeVarintField(3, 0),
      msg(5, writeVarintField(1, 7)), // safety_ratings: not declared, skipped
      msg(1, msg(1, msg(3, str(1, 'audio/wav'), writeBytesField(2, WAV))))), // a later content wins, as protobuf merges
    msg(3, writeVarintField(1, 23), writeVarintField(2, 26), writeVarintField(3, 49), writeVarintField(10, 0), msg(5, writeVarintField(1, 1))),
    str(4, 'gemini-3.8-flash'),
    str(5, 'l5rwaoGWCZqOytMPsI-bmA4'),
    writeVarintField(99, Number.MAX_SAFE_INTEGER), // a field the service may add tomorrow
  ]);

  const decoded = decode(GenerateContentResponse, wire);

  assert.equal(decoded.candidates.length, 1);
  assert.equal(decoded.candidates[0].finishReason, 'STOP');
  assert.equal(decoded.candidates[0].index, 0);
  const { parts } = decoded.candidates[0].content;
  assert.equal(parts.length, 1, 'the second content replaces the first: a singular message field');
  assert.equal(parts[0].inlineData.mimeType, 'audio/wav');
  assert.ok(parts[0].inlineData.data instanceof Uint8Array);
  assert.deepEqual(Buffer.from(parts[0].inlineData.data), WAV);
  assert.deepEqual(decoded.usageMetadata, { promptTokenCount: 23, candidatesTokenCount: 26, totalTokenCount: 49, thoughtsTokenCount: 0 });
  assert.equal(decoded.modelVersion, 'gemini-3.8-flash');
  assert.equal(decoded.responseId, 'l5rwaoGWCZqOytMPsI-bmA4');

  const textOnly = decode(GenerateContentResponse, msg(1, msg(1, msg(1, str(2, 'thinking...'), writeVarintField(11, 1)), msg(1, str(2, '{"a":1}'), writeBytesField(13, thoughtSignature)), str(2, 'model'))));
  assert.deepEqual(textOnly.candidates[0].content.parts.map((part) => [part.text, part.thought === true]), [['thinking...', true], ['{"a":1}', false]]);
  assert.deepEqual(Buffer.from(textOnly.candidates[0].content.parts[1].thoughtSignature), thoughtSignature);
});

test('a JSON Schema survives the trip through google.protobuf.Value exactly, the card schema included', () => {
  const odd = { s: 'ü 역', n: -1.5, i: 3, t: true, f: false, z: null, list: [1, 'two', [3], { four: 4 }], empty: {}, none: [] };
  assert.deepEqual(decodeValue(encodeValue(odd)), odd);
  assert.deepEqual(decodeValue(encodeValue(GENERATED_CARD_FORMAT.schema)), GENERATED_CARD_FORMAT.schema);
  // A number is a double on the wire (number_value, field 2).
  assert.equal(encodeValue(0.5).toString('hex'), writeDoubleField(2, 0.5).toString('hex'));
  assert.throws(() => encodeValue(Number.NaN), /no protobuf Value/);
});

test('a field the wire schema does not declare is refused, never silently dropped', () => {
  assert.throws(
    () => encode(GenerateContentRequest, { generationConfig: { temperature: 0.2 } }),
    /GenerateContentRequest\.generationConfig\.temperature is not a field amgi sends/,
  );
  assert.throws(
    () => encode(GenerateContentRequest, { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }),
    /"low" is not one of THINKING_LEVEL_UNSPECIFIED, LOW, MEDIUM, HIGH, MINIMAL/,
  );
  assert.throws(
    () => encode(GenerateContentRequest, { contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV.toString('base64') } }] }] }),
    /inlineData\.data must be bytes \(a Uint8Array\), not string/,
  );
});

test('such a request fails before anything is sent, and costs no request', async () => {
  const gemini = await fakeGemini();
  const error = await clientFor(gemini.baseUrl).generateContent('m', { generationConfig: { topK: 3 } }).then(() => null, (e) => e);
  assert.match(error.message, /topK is not a field amgi sends/);
  assert.equal(gemini.requests.length, 0);
  await gemini.close();
});

test('a quota refusal laid out per google/rpc/error_details.proto yields its quota id, limit and retry delay', () => {
  // google.rpc.Status {code 1, message 2, details 3: Any {type_url 1, value 2}}.
  const any = (type, value) => msg(3, str(1, `type.googleapis.com/google.rpc.${type}`), writeBytesField(2, value));
  const status = Buffer.concat([
    writeVarintField(1, 8),
    str(2, 'You exceeded your current quota.'),
    // QuotaFailure {violations 1: {quota_metric 4, quota_id 5, quota_value 7 (int64)}}
    any('QuotaFailure', msg(1,
      str(4, 'generativelanguage.googleapis.com/generate_requests_per_model_per_day'),
      str(5, 'GenerateRequestsPerDayPerProjectPerModel'),
      writeVarintField(7, 100))),
    // RetryInfo {retry_delay 1: Duration {seconds 1, nanos 2}}
    any('RetryInfo', msg(1, writeVarintField(1, 20556), writeVarintField(2, 250_000_000))),
  ]);

  assert.deepEqual(statusDetails(status.toString('base64')), {
    violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_day',
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel',
      quotaValue: 100,
    }],
    retryDelayMs: 20_556_250,
  });
});

test("RetryInfo's Duration becomes milliseconds, nanos included, and other detail types are skipped", () => {
  const details = statusDetails(encodeStatus({ code: 8, details: [
    { type: 'ErrorInfo', value: { reason: 'RATE_LIMIT_EXCEEDED' } },
    { type: 'QuotaFailure', value: { violations: [{ quotaId: 'PerMinute', quotaValue: 15 }] } },
    { type: 'RetryInfo', value: { retryDelay: { seconds: 2, nanos: 500_000_000 } } },
  ] }));
  assert.equal(details.retryDelayMs, 2500);
  assert.deepEqual(details.violations, [{ quotaId: 'PerMinute', quotaValue: 15 }]);
  assert.deepEqual(statusDetails(undefined), { violations: [], retryDelayMs: null });
  assert.deepEqual(statusDetails('not base64 of a Status!'), { violations: [], retryDelayMs: null });
});

test('a server that never answers is a retryable failure after the request timeout', async () => {
  const gemini = await fakeGemini({ transcribe: { raw: true, hang: true } });
  const error = await clientFor(gemini.baseUrl, { requestTimeoutMs: 150 })
    .generateContent('m', { contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV } }] }] })
    .then(() => null, (e) => e);
  assert.equal(error.message, 'Gemini request to m failed: no answer within 150 ms');
  assert.notEqual(error.fatal, true);
  await gemini.close();
});

test('an answer that is not gRPC is judged by its HTTP status: 4xx fatal, 5xx retryable', async () => {
  const notFound = await fakeGemini({ text: { raw: true, httpStatus: 404, body: 'Not Found' } });
  const request = { generationConfig: { responseJsonSchema: { type: 'object' } } };
  const fatal = await clientFor(notFound.baseUrl).generateContent('m', request).then(() => null, (e) => e);
  assert.ok(fatal instanceof GeminiUnavailableError);
  assert.equal(fatal.message, 'Gemini request to m failed (HTTP 404)');

  const badGateway = await fakeGemini({ text: { raw: true, httpStatus: 502 } });
  const retryable = await clientFor(badGateway.baseUrl).generateContent('m', request).then(() => null, (e) => e);
  assert.equal(retryable.message, 'Gemini request to m failed (HTTP 502)');
  assert.notEqual(retryable.fatal, true);
  await Promise.all([notFound.close(), badGateway.close()]);
});

test('nothing listening is a retryable failure, not a crash', async () => {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const error = await clientFor(`http://127.0.0.1:${port}`).generateContent('m', {}).then(() => null, (e) => e);
  assert.match(error.message, /^Gemini request to m failed: .*ECONNREFUSED/);
  assert.notEqual(error.fatal, true);
});

test('every gRPC code that maps to an HTTP 4xx is fatal, every 5xx one retryable, as under REST', async () => {
  const fatal = { 1: 'CANCELLED', 3: 'INVALID_ARGUMENT', 5: 'NOT_FOUND', 6: 'ALREADY_EXISTS', 7: 'PERMISSION_DENIED', 9: 'FAILED_PRECONDITION', 10: 'ABORTED', 11: 'OUT_OF_RANGE', 16: 'UNAUTHENTICATED' };
  const retryable = { 2: 'UNKNOWN', 4: 'DEADLINE_EXCEEDED', 12: 'UNIMPLEMENTED', 13: 'INTERNAL', 14: 'UNAVAILABLE', 15: 'DATA_LOSS' };
  const codes = [...Object.keys(fatal), ...Object.keys(retryable)].map(Number);
  const gemini = await fakeGemini({ unknown: (body, index) => grpcError(codes[index], 'x') });
  const client = clientFor(gemini.baseUrl);
  for (const code of codes) {
    const error = await client.generateContent('m', {}).then(() => null, (e) => e);
    const name = fatal[code] || retryable[code];
    assert.equal(error.message, `Gemini request to m failed (${name}): x`);
    assert.equal(error.fatal === true, code in fatal, `${name} fatal?`);
  }
  await gemini.close();
});

test('requests share one connection', async () => {
  const gemini = await fakeGemini({ transcribe: 'ok' });
  let sessions = 0;
  gemini.server.on('session', () => { sessions += 1; });
  const client = clientFor(gemini.baseUrl);
  const audio = { contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV } }] }] };
  await client.generateContent('m', audio);
  await Promise.all([client.generateContent('m', audio), client.generateContent('m', audio)]);
  assert.equal(gemini.requests.length, 3);
  assert.equal(sessions, 1);
  await gemini.close();
});

test('a process that made a request exits as soon as its work is done, without waiting out the idle connection', async () => {
  const gemini = await fakeGemini({ speech: wavAnswer(), text: textAnswer('{}') });
  const child = `
    const { createGeminiClient } = require(${JSON.stringify(path.join(__dirname, '../lib/cardGeneration/gemini.ts'))});
    const client = createGeminiClient({ apiKey: 'k', baseUrl: ${JSON.stringify(gemini.baseUrl)} });
    client.generateContent('m', { generationConfig: { responseModalities: ['AUDIO'] } })
      .then((r) => { process.stdout.write(String(r.candidates[0].content.parts[0].inlineData.data.length)); });
  `;
  const started = Date.now();
  const { code, stdout } = await new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.on('exit', (exitCode) => resolve({ code: exitCode, stdout: out }));
  });
  assert.equal(code, 0);
  assert.equal(stdout, String(WAV.length), 'the request completed before the exit');
  assert.ok(Date.now() - started < 10_000, `exited after ${Date.now() - started} ms; the idle close is 30 s`);
  await gemini.close();
});
