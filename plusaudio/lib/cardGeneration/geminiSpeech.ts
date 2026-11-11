// The WAV file Gemini speech answers become, for the tests' fake Gemini
// (plusaudio/test/helpers/fake-gemini.js), which answers a speech request with
// one. amgi's own speech client is C (server/amgi/gemini.c), and it turns
// what arrives into the same file: Gemini TTS models answer either a WAV
// ("audio/wav", 24 kHz mono 16-bit) or raw little-endian PCM
// ("audio/l16; rate=24000; channels=1"), and the PCM is wrapped in this
// canonical 44-byte header.

export const WAV_HEADER_BYTES = 44;

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
