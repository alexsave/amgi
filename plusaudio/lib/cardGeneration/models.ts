// Model roster, kept in one place so upgrades are a one-line change.
// - gpt-audio-1.5: GA speech-in/speech-out chat model, used here only as the
//   audio judge (successor of gpt-audio, which OpenAI is shutting down
//   2027-01-20 - see /private/tmp/.../scratchpad/tts-options.md for the
//   research behind this swap, dated 2026-09-19)
// - gpt-5-mini: fast text model for translation / card generation
// - gemini-3.8-flash-tts: speech synthesis, and the only synthesiser (see
//   geminiSpeech.ts). It replaced OpenAI's gpt-4o-mini-tts, which OpenAI
//   shuts down on 2027-01-06 and whose Japanese and Korean sounded like an
//   English speaker reading them; the owner compared clips side by side and
//   found Gemini's "way better". The account also has
//   gemini-3.8-flash-lite-tts and gemini-3.1-flash-tts-preview (the latter
//   answers raw PCM instead of WAV; geminiSpeech.ts handles both).
// - gpt-transcribe: transcription used to validate generated TTS audio,
//   successor of gpt-4o-mini-transcribe (shutdown 2027-02-26). Its request
//   shape differs from the old model's: the singular `language` field is
//   replaced by a `languages` array - see the call site in
//   generateCardAudio() in cardGeneration.ts.
//
// So speech comes from Google and everything else (card text, transcription,
// the audio judge) from OpenAI, and both keys are needed. Whether to move
// the other three off OpenAI too is an open decision, not an oversight.
//
// gpt-realtime (live conversation practice) used to be listed here too, but
// nothing in this codebase calls it - the realtime voice-mode feature is
// archived (see archives/realtime) - so it was removed rather than migrated
// to its own successor, gpt-realtime-2.1. Re-add it, migrated, only once
// something actually imports it again.
//
// Kept separate from any client wrapper so it stays runtime-agnostic
// policy: the plusaudio CLI has to generate with the same models the app's
// own local generation path does, or the two produce audibly different
// decks.

export const SPEECH_EVALUATION_MODEL = "gpt-audio-1.5";
export const TEXT_MODEL = "gpt-5-mini";
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
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
// The voices a clip is read in. Each clip draws one at random from this pool
// (through plusaudio/lib/random.js, the one seedable random source), and a
// retry after a failed validation always draws a different one than the
// attempt before it: the same voice tends to repeat the same
// mispronunciation. These three are the ones the owner listened to in the
// bake-off; none was preferred over the others, so all three stay in. Add or
// remove names here - Gemini lists its prebuilt voices in its TTS docs.
export const GEMINI_TTS_VOICES = ["Kore", "Aoede", "Charon"] as const;

export const TEXT_REASONING_EFFORT = "minimal";
export const TEXT_VERBOSITY = "low";

/** The models card generation needs, injected rather than imported by it. */
export interface CardModels {
    /** Structured-output text generation of the card sides. */
    text: string;
    /** Speech synthesis of a card side (a Gemini TTS model; see geminiSpeech.ts). */
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
    tts: GEMINI_TTS_MODEL,
    transcribe: TRANSCRIBE_MODEL,
    speechEvaluation: SPEECH_EVALUATION_MODEL,
    textReasoningEffort: TEXT_REASONING_EFFORT,
    textVerbosity: TEXT_VERBOSITY,
};
