// Model roster, kept in one place so a switch is a one-line change: each
// model below is ONE named constant, and nothing else in the codebase names a
// model. Every call goes to Google's Gemini API with one key, GEMINI_API_KEY
// (see gemini.ts); amgi has no other provider.
//
// Ids checked against GET /v1beta/models with the owner's key on 2026-11-08.
//
// - gemini-3.8-flash: card text (structured output), transcription of each
//   generated clip (audio in, text out), and the audio judge (audio in, a
//   structured verdict out). One model for all three by the owner's choice;
//   gemini-3.5-flash-lite (cheaper) and gemini-3.5-transcribe (a dedicated
//   speech-to-text model) are on the account too, and each is a one-constant
//   switch. Price through 2026-12-31: $0.75 per 1M input tokens, $3.75 per 1M
//   output tokens ($1.50 / $7.50 after); audio input is priced like text, at
//   about 32 tokens per second. Thinking tokens bill as output.
// - gemini-3.8-flash-tts: speech synthesis, the only synthesiser (see
//   geminiSpeech.ts). It replaced OpenAI's gpt-4o-mini-tts, which OpenAI
//   shuts down on 2027-01-06 and whose Japanese and Korean sounded like an
//   English speaker reading them; the owner compared clips side by side and
//   found Gemini's "way better". The account also has
//   gemini-3.8-flash-lite-tts and gemini-3.1-flash-tts-preview (the latter
//   answers raw PCM instead of WAV; geminiSpeech.ts handles both).
//
// Until 2026-11 card text, transcription and the judge were OpenAI's
// (gpt-5-mini, gpt-transcribe, gpt-audio-1.5); they moved so amgi needs one
// key, not two.
//
// Kept separate from the client so it stays runtime-agnostic policy: the
// plusaudio CLI has to generate with the same models the app's own local
// generation path does, or the two produce audibly different decks.

export const GEMINI_TEXT_MODEL = "gemini-3.8-flash";
export const GEMINI_TRANSCRIBE_MODEL = "gemini-3.8-flash";
export const GEMINI_JUDGE_MODEL = "gemini-3.8-flash";
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";

// The voices a clip is read in. Each clip draws one at random from this pool
// (through plusaudio/lib/random.js, the one seedable random source), and a
// retry after a failed validation always draws a different one than the
// attempt before it: the same voice tends to repeat the same
// mispronunciation. These three are the ones the owner listened to in the
// bake-off; none was preferred over the others, so all three stay in. Add or
// remove names here - Gemini lists its prebuilt voices in its TTS docs.
export const GEMINI_TTS_VOICES = ["Kore", "Aoede", "Charon"] as const;

// Thinking level for the text, transcription and judge calls
// (generationConfig.thinkingConfig.thinkingLevel). Filling a short
// structured template, writing down what a clip says, and a yes/no verdict
// do not need deliberation, and thinking tokens bill as output. "low" is the
// lowest gemini-3.8-flash accepts: "minimal" is answered with HTTP 400
// ("Thinking level MINIMAL is not supported for this model"), verified live
// 2026-11-08; the model's own default is "medium". A live card-text call at
// "low" spent 0 thinking tokens. Switching to a model that supports
// "minimal" (gemini-3.5-flash-lite does) is a change to this line too.
export const GEMINI_THINKING_LEVEL = "low";

/** The models card generation needs, injected rather than imported by it. */
export interface CardModels {
    /** Structured-output text generation of the card sides. */
    text: string;
    /** Speech synthesis of a card side (a Gemini TTS model; see geminiSpeech.ts). */
    tts: string;
    /** Transcription of generated audio, for the fast validation path. */
    transcribe: string;
    /** Audio-input model that listens to generated audio and judges it. */
    speechEvaluation: string;
    /** thinkingConfig.thinkingLevel for text, transcription and judge calls; omit for the model's default. */
    thinkingLevel?: string;
}

export const CARD_MODELS: CardModels = {
    text: GEMINI_TEXT_MODEL,
    tts: GEMINI_TTS_MODEL,
    transcribe: GEMINI_TRANSCRIBE_MODEL,
    speechEvaluation: GEMINI_JUDGE_MODEL,
    thinkingLevel: GEMINI_THINKING_LEVEL,
};
