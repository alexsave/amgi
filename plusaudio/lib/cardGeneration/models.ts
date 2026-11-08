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
// The lighter speech model, on the account (checked with GET /v1beta/models)
// and answering WAV like the full one. Not used at runtime: the owner chose it
// for re-recording the shipped starter clips only (scripts/build-starter-audio.js
// --model), which also keeps that bulk job off the runtime model's daily cap.
export const GEMINI_TTS_LITE_MODEL = "gemini-3.8-flash-lite-tts";

// The voices a clip is read in. Each clip draws one at random from this pool
// (through plusaudio/lib/random.js, the one seedable random source), and a
// retry after a failed validation always draws a different one than the
// attempt before it: the same voice tends to repeat the same
// mispronunciation. The owner's call: random, because hearing many speakers
// is good for a learner.
//
// Who is in it, and why. Gemini documents 30 prebuilt voices. On 2026-11-08
// each was asked, on gemini-3.8-flash-tts, to say 駅はどこですか。,
// 역이 어디예요? and Где находится вокзал?, and each clip went through the
// pipeline's own transcription check (pronunciation-aware for Korean). Every
// one of the 26 voices below passed all three (Despina's Korean on its
// second take, which the pipeline's retry would also have given it). Four
// documented voices - Vindemiatrix, Sadachbia, Sadaltager, Sulafat - are NOT
// here only because the project's Tier 1 cap (100 TTS requests per day per
// model) ran out before they were surveyed, not because they failed; add
// them once they have been through the same check.
//
// Passing a transcript check is not sounding good: only Kore, Aoede and
// Charon have been heard by the owner. Drop any voice here that sounds wrong
// - one clip per voice and language is saved for that audition.
export const GEMINI_TTS_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
    "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib",
    "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
    "Achird", "Zubenelgenubi"
] as const;

// Thinking level for the text, transcription and judge calls
// (generationConfig.thinkingConfig.thinkingLevel, the ThinkingLevel enum's
// name as geminiWire.ts sends it). Filling a short structured template,
// writing down what a clip says, and a yes/no verdict do not need
// deliberation, and thinking tokens bill as output. LOW is the lowest
// gemini-3.8-flash accepts: MINIMAL is refused (INVALID_ARGUMENT, "Thinking
// level MINIMAL is not supported for this model"), verified live 2026-11-08;
// the model's own default is MEDIUM. A live card-text call at LOW spent 0
// thinking tokens. Switching to a model that supports MINIMAL
// (gemini-3.5-flash-lite does) is a change to this line too.
export const GEMINI_THINKING_LEVEL = "LOW";

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
