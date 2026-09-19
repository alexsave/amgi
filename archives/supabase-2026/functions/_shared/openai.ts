import OpenAI from "npm:openai@^6.5.0";

// The model ids live in models.ts, which stays free of Deno APIs and npm:
// specifiers so the plusaudio CLI can import them too. Re-exported here so
// every edge function keeps importing its models from one place.
export {
    CARD_MODELS,
    REALTIME_MODEL,
    SPEECH_EVALUATION_MODEL,
    TEXT_MODEL,
    TRANSCRIBE_MODEL,
    TTS_MODEL,
    type CardModels,
} from "./models.ts";

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
