import OpenAI from "npm:openai@^6.5.0";

// Model roster, kept in one place so upgrades are a one-line change.
// - gpt-audio: GA speech-in/speech-out chat model (successor of gpt-4o-audio-preview)
// - gpt-5-mini: fast text model for translation / card generation
// - gpt-4o-mini-tts: steerable TTS with per-language instructions
// - gpt-4o-mini-transcribe: transcription used to validate generated TTS audio
// - gpt-realtime: GA realtime speech model for live conversation practice
export const SPEECH_EVALUATION_MODEL = "gpt-audio";
export const TEXT_MODEL = "gpt-5-mini";
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const REALTIME_MODEL = "gpt-realtime";

/**
 * Creates and returns an initialized OpenAI client.
 *
 * @returns An initialized OpenAI client
 * @throws Error if the OpenAI API key is not set in environment variables
 */
export function createOpenAIClient(): OpenAI {
    const apiKey = Deno.env.get('OPENAI_KEY');
    if (!apiKey) {
        throw new Error('OpenAI API key not found');
    }

    return new OpenAI({ apiKey });
}
