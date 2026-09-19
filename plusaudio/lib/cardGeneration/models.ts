// Model roster, kept in one place so upgrades are a one-line change.
// - gpt-audio-1.5: GA speech-in/speech-out chat model, used here only as the
//   audio judge (successor of gpt-audio, which OpenAI is shutting down
//   2027-01-20 - see /private/tmp/.../scratchpad/tts-options.md for the
//   research behind this swap, dated 2026-09-19)
// - gpt-5-mini: fast text model for translation / card generation
// - gpt-4o-mini-tts: steerable TTS with per-language instructions. Still
//   OpenAI's only and current TTS model as of the same research pass -
//   nothing to swap here.
// - gpt-transcribe: transcription used to validate generated TTS audio,
//   successor of gpt-4o-mini-transcribe (shutdown 2027-02-26). Its request
//   shape differs from the old model's: the singular `language` field is
//   replaced by a `languages` array - see the call site in
//   generateCardAudio() in cardGeneration.ts.
//
// gpt-realtime (live conversation practice) used to be listed here too, but
// nothing in this codebase calls it - the realtime voice-mode feature is
// archived (see archives/realtime) - so it was removed rather than migrated
// to its own successor, gpt-realtime-2.1. Re-add it, migrated, only once
// something actually imports it again.
//
// Kept separate from an OpenAI client wrapper so it stays runtime-agnostic
// policy: the plusaudio CLI has to generate with the same models the app's
// own local generation path does, or the two produce audibly different
// decks. (Before the replatform this also had to be Deno-safe, because the
// same ids were re-exported to a `cards`/`speech` edge function's own
// Deno-only openai.ts; that edge function is retired.)

export const SPEECH_EVALUATION_MODEL = "gpt-audio-1.5";
export const TEXT_MODEL = "gpt-5-mini";
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TRANSCRIBE_MODEL = "gpt-transcribe";

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
