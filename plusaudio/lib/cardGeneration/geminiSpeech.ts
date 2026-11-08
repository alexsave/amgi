// Speech synthesis through Google's Gemini TTS models - the only synthesiser
// amgi uses. (OpenAI's gpt-4o-mini-tts was the synthesiser until it was
// dropped: it is shut down on 2027-01-06, and its Japanese and Korean sounded
// like an English speaker reading them.)
//
// The HTTP request, the quota handling and the error messages are gemini.ts's;
// what is here is only what speech needs: the voice draw, the request shape,
// and turning the answer into a WAV file.
//
// What the API does, as verified live on 2026-11-07:
//   The audio comes back as candidates[0].content.parts[].inlineData
//   {mimeType, data(base64)}. gemini-3.8-* answer "audio/wav" with a RIFF
//   header (24 kHz mono 16-bit); gemini-3.1-flash-tts-preview answers raw PCM,
//   "audio/l16; rate=24000; channels=1", with no header at all. Never mp3.
//   Whatever arrives, what leaves this module is a complete WAV file.
//
// What it must NOT do: prepend free-form style or pronunciation text to the
// input. The model reads it aloud (verified), so by default the request
// carries the verbatim spoken text and nothing else. A Japanese reading
// therefore never reaches the synthesiser; it still reaches the audio judge
// (cardGeneration.ts).

import type { GeminiClient, GenerateContentResponse } from "./gemini.ts";

/** The one draw this module needs from the codebase's random source (plusaudio/lib/random.js). */
export interface RandomSource {
    /** A uniform integer in [0, n), one draw. */
    int(n: number): number;
}

export interface GeminiSpeechOptions {
    client: GeminiClient;
    model: string;
    /** The pool a clip's voice is drawn from; see models.ts's GEMINI_TTS_VOICES. */
    voices: readonly string[];
    random: RandomSource;
    /**
     * STEERING HOOK - DELIBERATELY NOT WIRED ON. A per-language style tag
     * (accent, pace), sent as a bracketed prefix of the input:
     * "[native Tokyo speaker, natural pitch accent] 駅はどこですか。".
     *
     * Why a bracket tag and nothing else, both tested live by the owner on
     * gemini-3.8-flash-tts (2026-11-08):
     *   - `systemInstruction` is refused outright: HTTP 400 "Developer
     *     instruction is not enabled for this model". Do not use it.
     *   - free-form text before the input is read aloud.
     *   - a bracketed tag is NOT read aloud: the clip was 1.84 s against
     *     1.64 s plain, and its transcript equalled the bare text.
     * Nothing passes this today: the default (no hook, or an empty string)
     * sends the verbatim text only, and it stays that way until the owner
     * has listened to tagged clips and chosen the tags.
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
// THE SYNTHESISER
// ========================

/** The text the model is asked to speak: the verbatim text, or "[tag] text" when a steering tag is given. */
export function spokenInput(text: string, tag: string): string {
    const trimmed = (tag || '').replace(/[[\]]/g, '').trim();
    return trimmed ? `[${trimmed}] ${text}` : text;
}

export function createGeminiSpeech(options: GeminiSpeechOptions): SpeechSynthesizer {
    const { client, model, voices, random, steering } = options;
    if (voices.length === 0) throw new Error('Gemini speech needs at least one voice');

    function pickVoice(previous: string | null): string {
        // One draw per pick whatever happens, so the draw sequence for a
        // given seed never depends on which voice came out last.
        const pool = previous !== null && voices.length > 1 ? voices.filter((voice) => voice !== previous) : [...voices];
        return pool[random.int(pool.length)];
    }

    async function synthesize({ text, language, voice }: SpeechRequest): Promise<ArrayBuffer> {
        const response = await client.generateContent(model, {
            contents: [{ parts: [{ text: spokenInput(text, steering ? steering(language) : '') }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
        });
        return audioFromResponse(response);
    }

    function audioFromResponse(data: GenerateContentResponse): ArrayBuffer {
        const candidate = data.candidates?.[0];
        const audioParts = (candidate?.content?.parts ?? []).filter((part) => part.inlineData?.data);
        if (audioParts.length === 0) {
            // finishReason OTHER happens now and then with no audio at all; a
            // fresh attempt with another voice usually succeeds, so this one
            // is not fatal.
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
