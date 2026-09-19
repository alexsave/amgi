// Model roster, kept in one place so upgrades are a one-line change.
// - gpt-audio: GA speech-in/speech-out chat model (successor of gpt-4o-audio-preview)
// - gpt-5-mini: fast text model for translation / card generation
// - gpt-4o-mini-tts: steerable TTS with per-language instructions
// - gpt-4o-mini-transcribe: transcription used to validate generated TTS audio
// - gpt-realtime: GA realtime speech model for live conversation practice
//
// Separate from openai.ts because the client there is Deno-only (Deno.env,
// npm: specifier) while the ids are runtime-agnostic policy: the plusaudio CLI
// has to generate with the same models the web app does, or the two produce
// audibly different decks.

export const SPEECH_EVALUATION_MODEL = "gpt-audio";
export const TEXT_MODEL = "gpt-5-mini";
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const REALTIME_MODEL = "gpt-realtime";

/** The models card generation needs, injected rather than imported by it. */
export interface CardModels {
    /** Structured-output text generation of the card sides. */
    text: string;
    /** Speech synthesis of a card side. */
    tts: string;
    /** Transcription of generated audio, for the fast validation path. */
    transcribe: string;
    /** Audio-input chat model that listens to generated audio and judges it. */
    speechEvaluation: string;
}

export const CARD_MODELS: CardModels = {
    text: TEXT_MODEL,
    tts: TTS_MODEL,
    transcribe: TRANSCRIBE_MODEL,
    speechEvaluation: SPEECH_EVALUATION_MODEL,
};
