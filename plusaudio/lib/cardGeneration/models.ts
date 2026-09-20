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

// gpt-5-mini is a reasoning model: left unset, every structured-output call
// (card generation, regeneration, and the transcript-match fallback judge -
// see parseCompletion's call sites in cardGeneration.ts) runs at the API
// default reasoning effort and spends tokens deliberating before it ever
// writes the JSON, and those tokens are billed as output - the billing
// dashboard finding that started this: gpt-5-mini OUTPUT was nearly half of
// total spend.
//
// Measured live on 2026-09-20 against 6 inputs (an English word, an
// ambiguous English word, a Korean input, a Japanese homograph, a full
// Korean sentence, and a full English sentence into Korean), then rechecked
// with repeats where the first pass looked noisy:
//
//   effort    avg output tok   avg reasoning tok   avg latency   avg cost/card
//   default          749               704             6.6s        $0.00178
//   low              216               171             2.1s        $0.00071
//   minimal           46                 0             0.9s        $0.00037
//
// minimal cuts output tokens ~94% and cost ~79% versus the unset default.
// Quality gate (the risk that actually matters): across the 6-input pass
// plus 8 more repeats at minimal targeting the two riskiest checks - English
// into Korean defaulting to 해요체, and the Japanese 行った/行われた
// homograph pair's spoken_reading - minimal held 100% (16/16): every
// Korean sentence came back 해요체, every Japanese reading was correct and
// in kana, and every card stayed one sense, speakable, and gloss-free. The
// one thing that did NOT hold cleanly at any effort level, including
// default, is the printed sense_tag/register PAREN LABEL on short words
// ("hello" sometimes labelled "(formal)" when 안녕하세요 is plain 해요체;
// "date" sometimes labelled with the sense it did NOT pick) - that label
// noise appeared at default and low too and was not worse at minimal, so
// it is an existing prompt weakness in the label fields, not something this
// change causes, and it never touched the actual translated text a card
// speaks or teaches. "low" bought nothing over "minimal" on any of this and
// cost roughly twice as much, so there was no case for stopping partway.
//
// Filling a short structured template does not need deliberation, so
// "minimal" is the default; verbosity is turned down to match, since the
// model is not writing prose. See plusaudio/test/textGenerator.test.js for
// the test that pins these values against silently drifting back to the
// (expensive) API default.
export const TEXT_REASONING_EFFORT = "minimal";
export const TEXT_VERBOSITY = "low";

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
    /**
     * Reasoning effort for `text` model calls ("minimal" | "low" | "medium" |
     * "high"). Only meaningful when `text` is a reasoning model. Omit to run
     * at the API's own default.
     */
    textReasoningEffort?: string;
    /**
     * Output verbosity for `text` model calls ("low" | "medium" | "high").
     * Omit to run at the API's own default.
     */
    textVerbosity?: string;
}

export const CARD_MODELS: CardModels = {
    text: TEXT_MODEL,
    tts: TTS_MODEL,
    transcribe: TRANSCRIBE_MODEL,
    speechEvaluation: SPEECH_EVALUATION_MODEL,
    textReasoningEffort: TEXT_REASONING_EFFORT,
    textVerbosity: TEXT_VERBOSITY,
};
