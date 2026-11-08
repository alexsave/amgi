// A fake of Google's generateContent endpoint for driving the card run end to end, no key and no
// quota: point the server's GEMINI_API_BASE at it. It speaks Gemini's own JSON (Google's protocol,
// not ours). Kinds are told apart as plusaudio/test/helpers/fake-gemini.js does.
//   text:  card text, known = the line, learning = a Korean sentence made from it
//   speech: a tone unique to the text; transcription answers that same text (so every clip passes)
//   judge: matches
// Control (POST /control?...): perMinute=N limits speech per model per rolling minute, answering
// Google's per-minute 429 with the real RetryInfo; daily=1 answers every text call with the per-day
// 429; daily=0 lifts it. A line that is exactly "broken line" fails its first text call with a 500.
//   node ui/tools/fake-gemini.mjs [port]
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 3198);
let perMinute = 1000;
let daily = false;
let brokenOnce = false;
const windows = new Map();
const synthetic = [];

const body = (req) => new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const text = (t) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: t }] } }] });

function admit(model, limit) {
  const now = Date.now();
  const starts = (windows.get(model) || []).filter((t) => now - t < 60_000);
  windows.set(model, starts);
  if (starts.length >= limit) return starts[0] + 60_000 - now;
  starts.push(now);
  return 0;
}

// Half a second of a tone whose pitch is the text's hash: the transcription finds it again.
function wav(said) {
  const rate = 24000;
  const samples = rate / 2;
  const pcm = Buffer.alloc(samples * 2);
  const freq = 200 + (crypto.createHash('sha1').update(said).digest()[0] % 200);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  const out = Buffer.concat([h, pcm]);
  synthetic.push({ needle: out.subarray(44 + 2 * freq, 44 + 2 * freq + 64), said });
  return out;
}

// A Korean sentence from a line: the line's own number, or its length.
const learning = (input) => `${(input.match(/\d+/) || [String(input.length)])[0]}번 문장이에요.`;

http.createServer(async (req, res) => {
  const raw = await body(req);
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/control') {
      if (url.searchParams.has('perMinute')) perMinute = Number(url.searchParams.get('perMinute'));
      if (url.searchParams.has('daily')) daily = url.searchParams.get('daily') === '1';
      windows.clear();
      res.writeHead(204);
      return res.end();
    }
    const m = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: { message: 'no route' } });
    const model = m[1];
    const request = JSON.parse(raw.toString('utf8'));
    const config = request.generationConfig || {};
    const parts = (request.contents || []).flatMap((c) => c.parts || []);
    const audio = parts.find((p) => p.inlineData);
    const kind = (config.responseModalities || []).includes('AUDIO') ? 'speech' : audio ? (config.responseJsonSchema ? 'judge' : 'transcribe') : 'text';

    if (kind === 'speech') {
      const waitMs = admit(model, perMinute);
      if (waitMs > 0) {
        return send(res, 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'per minute', details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', quotaValue: String(perMinute) }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${(waitMs / 1000).toFixed(1)}s` },
        ] } });
      }
      return send(res, 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav(parts[0].text).toString('base64') } }] } }] });
    }
    if (audio) {
      const bytes = Buffer.from(audio.inlineData.data, 'base64');
      const heard = synthetic.find((s) => bytes.includes(s.needle))?.said ?? '';
      if (config.responseJsonSchema) return send(res, 200, text(JSON.stringify({ heard, matches: true, reason: 'fake' })));
      return send(res, 200, text(heard));
    }
    if (daily) {
      return send(res, 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'per day', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20000s' },
      ] } });
    }
    const prompt = parts.map((p) => p.text || '').join('\n');
    const input = (/Their input: "([^"\n]+)"/.exec(prompt) || [])[1] || 'line';
    if (input === 'broken line' && !brokenOnce) {
      brokenOnce = true;
      return send(res, 500, { error: { code: 500, message: 'The model is overloaded. Please try again later.' } });
    }
    return send(res, 200, text(JSON.stringify({ known_text: input, learning_text: learning(input), sense_tag: '', register: 'polite', spoken_reading: '' })));
  } catch (error) {
    send(res, 500, { error: { message: error.message } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`fake Gemini on ${PORT}`));
