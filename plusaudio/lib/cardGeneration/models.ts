// Model roster, kept in one place so upgrades are a one-line change.
// - gpt-audio: GA speech-in/speech-out chat model (successor of gpt-4o-audio-preview)
// - gpt-5-mini: fast text model for translation / card generation
// - gpt-4o-mini-tts: steerable TTS with per-language instructions
// - gpt-4o-mini-transcribe: transcription used to validate generated TTS audio
// - gpt-realtime: GA realtime speech model for live conversation practice
//
// Kept separate from an OpenAI client wrapper so it stays runtime-agnostic
// policy: the plusaudio CLI has to generate with the same models the app's
// own local generation path does, or the two produce audibly different
// decks. (Before the replatform this also had to be Deno-safe, because the
// same ids were re-exported to a `cards`/`speech` edge function's own
// Deno-only openai.ts; that edge function is retired.)

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
