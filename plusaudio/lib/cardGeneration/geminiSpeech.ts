// Speech synthesis through Google's Gemini TTS models - the only synthesiser
// amgi uses. (OpenAI's gpt-4o-mini-tts was the synthesiser until it was
// dropped: it is shut down on 2027-01-06, and its Japanese and Korean sounded
// like an English speaker reading them. Card text, transcription and the
// audio judge are still OpenAI's - see models.ts.)
//
// Like the rest of cardGeneration/, this module reads no environment variable
// and owns no global state: the key, the base URL, fetch, the clock's sleep
// and the random source are all injected, so a test drives it with a fake
// fetch and a seeded generator and never reaches the network.
//
// What the API does, as verified live on 2026-11-07:
//   POST {base}/v1beta/models/{model}:generateContent, header x-goog-api-key.
//   The audio comes back as candidates[0].content.parts[].inlineData
//   {mimeType, data(base64)}. gemini-3.8-* answer "audio/wav" with a RIFF
//   header (24 kHz mono 16-bit); gemini-3.1-flash-tts-preview answers raw PCM,
//   "audio/l16; rate=24000; channels=1", with no header at all. Never mp3.
//   Whatever arrives, what leaves this module is a complete WAV file.
//
// What it must NOT do: prepend style or pronunciation text to the input. The
// model reads it aloud (verified), so the request carries the verbatim
// spoken text and nothing else. A Japanese reading therefore never reaches
// the synthesiser; it still reaches the audio judge (cardGeneration.ts).

/** The one draw this module needs from the codebase's random source (plusaudio/lib/random.js). */
export interface RandomSource {
    /** A uniform integer in [0, n), one draw. */
    int(n: number): number;
}

type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;

export interface GeminiSpeechOptions {
    apiKey: string;
    model: string;
    /** The pool a clip's voice is drawn from; see models.ts's GEMINI_TTS_VOICES. */
    voices: readonly string[];
    random: RandomSource;
    fetch?: FetchLike;
    /** Defaults to Google's endpoint. Overridden only by tests and the e2e fake server. */
    baseUrl?: string;
    sleep?: (ms: number) => Promise<void>;
    /** The most a per-minute rate limit may make one clip wait, in total. */
    maxRateLimitWaitMs?: number;
    requestTimeoutMs?: number;
    /**
     * STEERING HOOK - DELIBERATELY NOT WIRED ON. A per-language instruction
     * (accent, pace) that would be sent as the request's `systemInstruction`,
     * never as part of the spoken text. Whether the TTS models honour
     * systemInstruction at all is untested (the free tier's 10 requests per
     * day did not leave room to find out), so nothing passes this today and
     * nothing may come to depend on it until someone has heard what it does.
     */
    steering?: (language: string) => string;
}

export interface SpeechRequest {
    text: string;
    language: string;
    voice: string;
}

export interface SpeechSynthesizer {
    /** The voice for the next attempt: drawn at random, never the previous attempt's. */
    pickVoice(previous: string | null): string;
    /** One clip as a complete WAV file. */
    synthesize(request: SpeechRequest): Promise<ArrayBuffer>;
}

/**
 * A failure no retry can fix: the day's quota is spent, the key is refused,
 * the text is blocked. generateCardAudio rethrows these at once instead of
 * spending its remaining attempts (and the remaining quota) on them, and the
 * message is shown to the person verbatim, so it is one line and says what
 * to do.
 */
export class SpeechUnavailableError extends Error {
    readonly fatal = true;
    constructor(message: string) {
        super(message);
        this.name = 'SpeechUnavailableError';
    }
}

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';

/** The message a spent daily quota surfaces as, word for word, in the add-card row. */
export function dailyQuotaMessage(model: string): string {
    return `Gemini's free tier allows 10 speech requests per day per model, and today's are used up for ${model}. ` +
        `Enable billing for your Gemini API key's project in Google AI Studio (${GEMINI_KEY_PAGE}) to lift the limit, or try again tomorrow.`;
}

// ========================
// WAV
// ========================

export const WAV_HEADER_BYTES = 44;

/** Whether `bytes` start with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

/** Wraps raw little-endian 16-bit PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
    const bitsPerSample = 16;
    const blockAlign = channels * (bitsPerSample / 8);
    const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
    const view = new DataView(out.buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    ascii(36, 'data');
    view.setUint32(40, pcm.length, true);
    out.set(pcm, WAV_HEADER_BYTES);
    return out;
}

/**
 * Turns one inlineData part into a WAV file, or throws.
 *
 * Raw PCM ("audio/l16", "audio/pcm") is wrapped, with the sample rate and
 * channel count read from the mime type's parameters (24000 Hz mono when they
 * are absent, which is what every Gemini TTS model produces). RFC 2586 says
 * L16 is big-endian, but Gemini's is little-endian - Google's own sample code
 * writes it straight into a WAV file - and so is a WAV file, so the bytes are
 * copied, not swapped.
 */
export function audioPartToWav(mimeType: string, bytes: Uint8Array): Uint8Array {
    const mime = (mimeType || '').toLowerCase();
    if (/^audio\/(?:x-)?wav\b|^audio\/wave\b/.test(mime)) {
        if (!isWav(bytes)) throw new Error(`Gemini said ${mimeType} but the bytes have no RIFF/WAVE header`);
        return bytes;
    }
    if (/^audio\/(?:l16|pcm)\b/.test(mime)) {
        const rate = Number(/\brate=(\d+)/.exec(mime)?.[1] ?? 24000);
        const channels = Number(/\bchannels=(\d+)/.exec(mime)?.[1] ?? 1);
        if (!(rate > 0) || !(channels > 0)) throw new Error(`Gemini audio has an unusable format: ${mimeType}`);
        return pcmToWav(bytes, rate, channels);
    }
    throw new Error(`Gemini returned audio in an unexpected format: ${mimeType || 'no mime type'}`);
}

function base64ToBytes(data: string): Uint8Array {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

// ========================
// ERRORS AND QUOTA
// ========================

interface GoogleErrorDetail {
    '@type'?: string;
    violations?: Array<{ quotaId?: string; quotaMetric?: string }>;
    retryDelay?: string;
}

interface GoogleErrorBody {
    error?: { code?: number; message?: string; status?: string; details?: GoogleErrorDetail[] };
}

function parseErrorBody(text: string): GoogleErrorBody {
    try {
        return JSON.parse(text) as GoogleErrorBody;
    } catch {
        return {};
    }
}

/** "23s" / "1.5s" -> milliseconds, or null. */
function parseRetryDelay(value: string | undefined): number | null {
    const match = /^(\d+(?:\.\d+)?)s$/.exec((value || '').trim());
    return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/** A per-day limit cannot be waited out; anything else (per minute, unlabelled) can, briefly. */
function isDailyQuota(details: GoogleErrorDetail[]): boolean {
    return details.some((detail) => (detail.violations || []).some((violation) =>
        /PerDay/i.test(violation.quotaId || '') || /per_day|PerDay/i.test(violation.quotaMetric || '')));
}

/** Used when a 429 carries no RetryInfo of its own. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 5000;

// ========================
// THE SYNTHESISER
// ========================

export function createGeminiSpeech(options: GeminiSpeechOptions): SpeechSynthesizer {
    const {
        apiKey,
        model,
        voices,
        random,
        fetch: fetchImpl = globalThis.fetch as unknown as FetchLike,
        baseUrl = GEMINI_API_BASE,
        sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        maxRateLimitWaitMs = 30_000,
        requestTimeoutMs = 60_000,
        steering,
    } = options;

    if (!apiKey) throw new SpeechUnavailableError('GEMINI_API_KEY is not set; audio was not generated.');
    if (voices.length === 0) throw new Error('Gemini speech needs at least one voice');

    const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    function pickVoice(previous: string | null): string {
        // One draw per pick whatever happens, so the draw sequence for a
        // given seed never depends on which voice came out last.
        const pool = previous !== null && voices.length > 1 ? voices.filter((voice) => voice !== previous) : [...voices];
        return pool[random.int(pool.length)];
    }

    function requestBody({ text, language, voice }: SpeechRequest): string {
        const body: Record<string, unknown> = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
        };
        const instruction = steering ? steering(language).trim() : '';
        if (instruction) body.systemInstruction = { parts: [{ text: instruction }] };
        return JSON.stringify(body);
    }

    async function synthesize(request: SpeechRequest): Promise<ArrayBuffer> {
        const body = requestBody(request);
        let waitedMs = 0;

        for (;;) {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
                body,
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            const text = await response.text();

            if (response.status === 429) {
                const error = parseErrorBody(text).error ?? {};
                const details = error.details ?? [];
                if (isDailyQuota(details)) throw new SpeechUnavailableError(dailyQuotaMessage(model));
                const retryInfo = details.find((detail) => detail.retryDelay !== undefined);
                const delayMs = parseRetryDelay(retryInfo?.retryDelay) ?? DEFAULT_RATE_LIMIT_DELAY_MS;
                if (waitedMs + delayMs > maxRateLimitWaitMs) {
                    throw new SpeechUnavailableError(
                        `Gemini is limiting how many speech requests ${model} takes per minute and asked to wait ${Math.ceil(delayMs / 1000)}s; try again in a minute.`,
                    );
                }
                await sleep(delayMs);
                waitedMs += delayMs;
                continue;
            }

            if (!response.ok) {
                const message = (parseErrorBody(text).error?.message || text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                const summary = `Gemini speech request failed (HTTP ${response.status})${message ? `: ${message}` : ''}`;
                // A refused key, a bad request or an unknown model fails the
                // same way on every retry; a server error might not.
                if (response.status >= 400 && response.status < 500) throw new SpeechUnavailableError(summary);
                throw new Error(summary);
            }

            return audioFromResponse(text);
        }
    }

    function audioFromResponse(text: string): ArrayBuffer {
        let data: {
            promptFeedback?: { blockReason?: string };
            candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
        };
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('Gemini returned a response that is not JSON');
        }

        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) throw new SpeechUnavailableError(`Gemini refused to read this text aloud (${blockReason}).`);

        const candidate = data.candidates?.[0];
        const audioParts = (candidate?.content?.parts ?? []).filter((part) => part.inlineData?.data);
        if (audioParts.length === 0) {
            // finishReason OTHER happens now and then with no audio at all; a
            // fresh attempt with another voice usually succeeds, so this one
            // is not fatal. SAFETY would repeat, but is rare enough for TTS
            // that spending a retry on it beats a special case.
            throw new Error(`Gemini returned no audio (finishReason: ${candidate?.finishReason ?? 'none'})`);
        }

        const wavs = audioParts.map((part) => {
            const inline = part.inlineData!;
            return { mime: inline.mimeType ?? '', bytes: base64ToBytes(inline.data!) };
        });
        // A long answer can in principle arrive as several raw PCM parts;
        // those are one stream and are joined before wrapping. Several WAV
        // parts have never been seen, so only the first is used.
        let wav: Uint8Array;
        if (wavs.length > 1 && wavs.every((part) => /^audio\/(?:l16|pcm)\b/i.test(part.mime))) {
            const total = wavs.reduce((sum, part) => sum + part.bytes.length, 0);
            const joined = new Uint8Array(total);
            let offset = 0;
            for (const part of wavs) {
                joined.set(part.bytes, offset);
                offset += part.bytes.length;
            }
            wav = audioPartToWav(wavs[0].mime, joined);
        } else {
            wav = audioPartToWav(wavs[0].mime, wavs[0].bytes);
        }
        return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    }

    return { pickVoice, synthesize };
}
