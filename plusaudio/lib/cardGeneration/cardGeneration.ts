// How an amgi card is made: the structured-output calls that write it, and the
// loop that refuses audio which does not say what the card says.
//
// This is the whole generation policy, and it is deliberately the only copy.
// It is Node's, run from plusaudio/lib/generator.js - by the plusaudio CLI
// directly, and by the app's own local generation path and the Anki add-on's
// bridge, both of which shell out to plusaudio/generate-clip.js - so a deck
// built any of those ways is built to the same standard, instead of drifting
// into a second, worse generator.
//
// This module used to run in a Deno edge function too (the hosted Supabase
// backend, retired - see archives/supabase-2026/), which is why it still
// avoids Deno APIs and npm:/jsr: imports: those constraints cost nothing now
// and there is no reason to add either kind of dependency to a module that
// otherwise has none.
//
// What is in here: prompts (via cardPrompts.ts), schemas, assembly (via
// cardText.ts), the corrective retry for unspeakable text, and the
// synthesise-transcribe-judge validation loop. Every model call goes through
// one injected Gemini client (gemini.ts); the synthesiser (geminiSpeech.ts)
// is injected beside it.
//
// What is NOT in here, and must stay out: authentication, quota, storage,
// the database, environment variables, and any runtime-specific API. The
// Gemini client, the speech synthesiser and the model ids are injected (see
// CardGenerationContext)
// so a test can drive the whole policy without a key or a network. Keeping
// the module free of npm: specifiers is what lets Node require it directly,
// with no build step and so no artifact that can drift from its source.

import {
    assembleCard,
    composeKnownSide,
    languageName,
    normalizeForComparison,
    readingIsAmbiguous,
    registerTag,
    spokenForm,
    type AssembledCard,
    type GeneratedCardFields,
} from "./cardText.ts";
import {
    CARD_GENERATION_SYSTEM_PROMPT,
    CARD_REGENERATION_SYSTEM_PROMPT,
    buildBothSidesRegenerationPrompt,
    buildCardGenerationPrompt,
    buildKnownSideRegenerationPrompt,
    buildLearningSideRegenerationPrompt,
    buildUnspeakableRetryPrompt,
} from "./cardPrompts.ts";
import type { CardModels } from "./models.ts";
import type { SpeechSynthesizer } from "./geminiSpeech.ts";
import { bytesToBase64, responseText, type GeminiClient, type GenerateContentRequest } from "./gemini.ts";

/** Where the module's warnings go; console in both runtimes unless overridden. */
export interface GenerationLog {
    warn(message: string): void;
    error(message: string): void;
}

const CONSOLE_LOG: GenerationLog = {
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
};

export interface CardGenerationContext {
    /** Every text, transcription and judge call goes through this one client. */
    gemini: GeminiClient;
    models: CardModels;
    /** Needed only by generateCardAudio; card text never touches it. */
    speech?: SpeechSynthesizer;
    log?: GenerationLog;
}

function logOf(ctx: CardGenerationContext): GenerationLog {
    return ctx.log ?? CONSOLE_LOG;
}

/** Thrown values are not always Errors, and the failure text is user-visible. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ========================
// SCHEMA DEFINITIONS
// ========================

// The model returns the PARTS of a card, not the card. Assembling them is
// cardText.assembleCard's job, which is what keeps a gloss out of the text
// that gets synthesised: the learning side is only ever the utterance, and
// every label the learner needs to read is composed onto the known side.
//
// Language codes are not asked for any more. They are decided by the request -
// the front is the deck's known language and the back its learning language,
// by construction - so asking the model invited a "Korean" or "ko-KR" that
// would have silently degraded the transcription language hint.
//
// Written as plain JSON Schema (draft-07), which Gemini's
// generationConfig.responseJsonSchema takes as is - $schema, enum and
// additionalProperties included, verified live 2026-11-08 - and which keeps
// this module free of a schema library.

const SENSE_TAG_FIELD = {
    type: "string",
    // Empty is the normal answer, and the description says so first: the
    // field's own wording is the last thing read before it is filled in, and
    // describing what a tag contains before saying when to omit one is what
    // produced "Are you hungry? (hungry now)".
    description: "Usually empty. Fill it only when the input genuinely has a second, equally everyday meaning that a different card could teach - then two or three words in the learner's own language naming which of those meanings this card teaches, for example 'calendar day' for 'date'. Never a restatement, summary, topic or tone of the card itself.",
} as const;

const REGISTER_FIELD = {
    type: "string",
    enum: ["casual", "polite", "formal"],
    description: "The politeness level the learning-language text actually uses",
} as const;

const SPOKEN_READING_FIELD = {
    type: "string",
    description: "How the learning-language text must be read aloud, in the learning language's own script (kana for Japanese, zhuyin/bopomofo for Chinese) - never romanised. Empty unless the writing system leaves the reading open (Japanese, Chinese).",
} as const;

const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

export interface StructuredResponseFormat {
    /** Names the format in error messages and logs; not sent. */
    name: string;
    /** Sent as generationConfig.responseJsonSchema. */
    schema: Record<string, unknown>;
}

function responseFormat(name: string, properties: Record<string, unknown>): StructuredResponseFormat {
    return {
        name,
        schema: {
            type: "object",
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
            $schema: JSON_SCHEMA_DRAFT,
        },
    };
}

/** A whole card: both sides, plus the labels the known side carries. */
export const GENERATED_CARD_FORMAT = responseFormat("flashcard_generation", {
    known_text: { type: "string", description: "The known-language side: one natural utterance, no annotation of any kind" },
    learning_text: { type: "string", description: "The learning-language side: one natural utterance in one sense, no annotation of any kind" },
    sense_tag: SENSE_TAG_FIELD,
    register: REGISTER_FIELD,
    spoken_reading: SPOKEN_READING_FIELD,
});

/** The learning side alone, when only it was rejected. */
export const LEARNING_SIDE_FORMAT = responseFormat("learning_side_regeneration", {
    learning_text: { type: "string", description: "The rewritten learning-language side: one natural utterance in one sense, no annotation of any kind" },
    sense_tag: SENSE_TAG_FIELD,
    register: REGISTER_FIELD,
    spoken_reading: SPOKEN_READING_FIELD,
});

/** The known side alone. It carries no reading: nothing on it is synthesised in an opaque script. */
export const KNOWN_SIDE_FORMAT = responseFormat("known_side_regeneration", {
    known_text: { type: "string", description: "The rewritten known-language side: one natural utterance, no annotation of any kind" },
    sense_tag: SENSE_TAG_FIELD,
    register: REGISTER_FIELD,
});

const TRANSCRIPTION_MATCH_FORMAT = responseFormat("transcription_match", {
    matches: { type: "boolean" },
});

/** The generationConfig every non-speech call shares: the thinking level from models.ts. */
function thinkingConfig(ctx: CardGenerationContext): Record<string, unknown> {
    // Filling a short structured template, writing down what a clip says and
    // a yes/no verdict do not benefit from deliberation, and thinking tokens
    // bill as output - see models.ts's GEMINI_THINKING_LEVEL. Omitted (not
    // sent as undefined) when the injected config leaves it unset.
    return ctx.models.thinkingLevel ? { thinkingConfig: { thinkingLevel: ctx.models.thinkingLevel } } : {};
}

/** A structured-output request: JSON back, shaped by `format`. */
function structuredRequest(
    ctx: CardGenerationContext,
    systemPrompt: string,
    parts: GenerateContentRequest[],
    format: StructuredResponseFormat,
): GenerateContentRequest {
    return {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: format.schema,
            ...thinkingConfig(ctx),
        },
    };
}

/** Parses a structured answer, or says which format the model failed to fill. */
function parseStructured<T>(text: string, format: StructuredResponseFormat): T {
    if (!text) throw new Error(`Failed to parse ${format.name} from model response`);
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`Failed to parse ${format.name} from model response`);
    }
}

/**
 * Runs a structured-output text call and returns the parsed object.
 */
async function parseCompletion<T>(
    ctx: CardGenerationContext,
    systemPrompt: string,
    userPrompt: string,
    format: StructuredResponseFormat,
): Promise<T> {
    const response = await ctx.gemini.generateContent(
        ctx.models.text,
        structuredRequest(ctx, systemPrompt, [{ text: userPrompt }], format),
    );
    return parseStructured<T>(responseText(response), format);
}

/**
 * Runs the structured-output call and, when the model breaks the speakable
 * rule (a gloss, two senses, a slash alternative), tells it what it broke and
 * asks once more. The repaired text from cardText is the floor, not the goal:
 * repairing keeps whichever sense came first, while a corrected model picks
 * the sense a learner meant.
 */
async function generateSpeakableSide<T extends GeneratedCardFields>(
    ctx: CardGenerationContext,
    systemPrompt: string,
    userPrompt: string,
    format: StructuredResponseFormat,
    learningLanguage: string,
): Promise<{ fields: T; assembled: AssembledCard }> {
    let prompt = userPrompt;
    let last: { fields: T; assembled: AssembledCard } | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const fields = await parseCompletion<T>(ctx, systemPrompt, prompt, format);
        const assembled = assembleCard(fields, learningLanguage);
        last = { fields, assembled };

        if (!assembled.repairedReason) return last;

        logOf(ctx).warn(`Unspeakable ${learningLanguage} text on attempt ${attempt}/2: "${fields.learning_text}" (${assembled.repairedReason})`);
        prompt = buildUnspeakableRetryPrompt(userPrompt, fields.learning_text, assembled.repairedReason);
    }

    logOf(ctx).warn(`Model kept returning unspeakable text; using the repaired form "${last!.assembled.back_text}"`);
    return last!;
}

// ========================
// AUDIO
// ========================

const AUDIO_JUDGE_SYSTEM_PROMPT = `You are a strict quality judge for text-to-speech audio used on language-learning flashcards. You are given the exact phrase the audio must say and the language it must be spoken in, followed by the audio clip. Listen carefully and judge whether the clip:
1. Says exactly the expected phrase - no missing, extra, or different words. Natural readings (numerals read out as words, expanded abbreviations, spoken or skipped punctuation) are acceptable.
2. Is spoken in the expected language with clear, intelligible pronunciation.
3. When an expected reading is given, uses that reading. The written form has more than one possible pronunciation, and reading the same characters a different way is a mismatch even though the words are right.
Judge only what you actually hear in the audio. Answer with what you heard and your verdict.`;

const AUDIO_VERDICT_FORMAT = responseFormat("audio_verdict", {
    heard: { type: "string", description: "What the audio actually says, as heard" },
    matches: { type: "boolean", description: "True if the audio says exactly the expected phrase in the expected language with intelligible pronunciation" },
    reason: { type: "string", description: "Brief justification for the verdict" },
});

/** Every clip is WAV (geminiSpeech.ts guarantees it). */
function audioPart(audioBuffer: ArrayBuffer): GenerateContentRequest {
    return { inlineData: { mimeType: "audio/wav", data: bytesToBase64(audioBuffer) } };
}

interface AudioVerdict {
    matches: boolean;
    heard: string;
    reason: string;
}

/**
 * Judges generated TTS audio by listening to it directly with an audio-input
 * model. Unlike a transcription round-trip, this works uniformly for any
 * language: there is no intermediate transcript in a possibly different
 * script or language to compare against, and it can also catch wrong-language
 * or garbled pronunciation that a transcript would hide.
 */
async function judgeAudio(
    ctx: CardGenerationContext,
    audioBuffer: ArrayBuffer,
    text: string,
    language: string,
    reading = ''
): Promise<AudioVerdict> {
    const readingLine = reading
        ? `\nIt must be read aloud as: ${reading}. This writing system allows more than one reading of the same characters, so a different reading is a mismatch.`
        : '';

    const response = await ctx.gemini.generateContent(
        ctx.models.speechEvaluation,
        structuredRequest(ctx, AUDIO_JUDGE_SYSTEM_PROMPT, [
            { text: `Expected phrase (language: ${languageName(language)}): "${text}"${readingLine}\nJudge this audio:` },
            audioPart(audioBuffer),
        ], AUDIO_VERDICT_FORMAT),
    );
    const verdict = parseStructured<Partial<AudioVerdict>>(responseText(response), AUDIO_VERDICT_FORMAT);
    return {
        matches: verdict.matches === true,
        heard: String(verdict.heard ?? ''),
        reason: String(verdict.reason ?? '')
    };
}

/**
 * What the clip says, written down by an audio-input model - the fast path's
 * half of validation. Asked for the language's own script, verbatim, so the
 * comparison below compares like with like; a transcriber that drifts into
 * another script or a translation only sends the clip on to the judge.
 * Exported so a survey script (a new voice, a new model) checks clips with
 * exactly the step the pipeline uses.
 */
export async function transcribeAudio(ctx: CardGenerationContext, audioBuffer: ArrayBuffer, language: string): Promise<string> {
    const name = languageName(language);
    const response = await ctx.gemini.generateContent(ctx.models.transcribe, {
        contents: [{
            role: "user",
            parts: [
                { text: `Transcribe this ${name} audio exactly as spoken, in ${name}'s own writing system. Do not translate, romanise, explain or correct it. Answer with the transcript only.` },
                audioPart(audioBuffer),
            ],
        }],
        generationConfig: { ...thinkingConfig(ctx) },
    });
    return responseText(response);
}

export interface CardAudioRequest {
    /** Card text as the learner sees it; annotations are stripped before synthesis. */
    text: string;
    language: string;
    /** The reading of `text` in its own script (see cardText.ts's READING_SYSTEMS), only meaningful where the script hides the reading. */
    reading?: string;
    maxAttempts?: number;
}

/**
 * Generates TTS audio and validates it before accepting it.
 *
 * Only the spoken form of the text (annotations stripped) is voiced and
 * validated. Fast path: transcribe the audio and compare against the spoken
 * form after lenient normalization. On any disagreement, escalate to an
 * audio-input model that listens to the clip itself and judges whether it
 * says the expected phrase in the expected language. The transcript is
 * deliberately not the arbiter: for short phrases, loanwords, and
 * less-supported languages the transcriber often drifts into another script
 * or translates what it heard, which is a transcription failure, not an
 * audio failure.
 *
 * WHAT THE TRANSCRIPT CHECK CANNOT SEE. It compares spelling. Where spelling
 * does not fix pronunciation - Japanese and Chinese, above all - a wrong
 * reading of the right characters comes back transcribed as the right
 * characters and passes: Japanese 行った read "okonatta" instead of "itta" is
 * invisible to it, and those are exactly the words a learner most needs the
 * audio to be right about. So for those languages the transcript is not
 * allowed to be the last word: when generation gave us the intended reading,
 * the clip always goes to the audio judge, which is told the reading and
 * listens for it. (The reading never reaches the synthesiser: Gemini TTS
 * has no instructions field, and text added to the input is read aloud.)
 * Two honest gaps remain, and neither is silent:
 *   - Audio regenerated for an existing card (the modal's audio button, the
 *     starter-deck backfill, every clip plusaudio adds to a deck it did not
 *     write) carries no reading, because no card column stores one. Those
 *     fall back to the transcript check and are logged.
 *   - The synthesiser, the transcriber and the judge are all Google's
 *     (Gemini TTS, and gemini-3.8-flash for both checks), so a systematic
 *     mispronunciation they share - the same model family reading a word the
 *     same wrong way, and hearing it as right - would pass. Before 2026-11
 *     the checks were OpenAI's and this gap was a cross-vendor one; it is not
 *     any more, and nothing here pretends otherwise.
 *
 * Each attempt draws a voice from the synthesiser's pool, never the voice of
 * the attempt before it: the same voice tends to repeat the same
 * mispronunciation.
 *
 * Fails closed: if no attempt produces audio that passes validation, throws.
 * A failure no retry can fix (GeminiUnavailableError: the day's Gemini quota
 * is spent, the key is refused) is thrown at once, with its own message, so
 * the person sees what to do instead of "failed after 3 attempts".
 *
 * Returns a complete WAV file.
 */
export async function generateCardAudio(
    ctx: CardGenerationContext,
    { text, language, reading = '', maxAttempts = 3 }: CardAudioRequest,
): Promise<ArrayBuffer> {
    const log = logOf(ctx);
    const speech = ctx.speech;
    if (!speech) throw new Error('generateCardAudio needs a speech synthesiser in its context');
    const spoken = spokenForm(text);
    // A reading is only meaningful where the script hides one.
    const expectedReading = readingIsAmbiguous(language) ? reading.trim() : '';
    const readingMustBeHeard = expectedReading.length > 0;
    let lastFailure = '';
    let voice: string | null = null;

    if (!readingMustBeHeard && readingIsAmbiguous(language)) {
        log.warn(`No expected reading for "${spoken}" (${language}); the transcript check cannot tell which reading was spoken`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            voice = speech.pickVoice(voice);
            // The verbatim spoken text and nothing else: anything added to
            // it (a style note, the reading) is read aloud by the model.
            const audioBuffer = await speech.synthesize({ text: spoken, language, voice });

            const transcript = await transcribeAudio(ctx, audioBuffer, language);
            // By pronunciation for Korean, where liaison makes different
            // spellings sound the same (see normalizeForComparison).
            const transcriptMatches = normalizeForComparison(transcript, language) === normalizeForComparison(spoken, language);

            if (transcriptMatches && !readingMustBeHeard) {
                return audioBuffer;
            }

            let verdict: AudioVerdict;
            try {
                verdict = await judgeAudio(ctx, audioBuffer, spoken, language, expectedReading);
            } catch (judgeError) {
                // A spent quota or a refused key fails the transcript
                // fallback too; say so now instead of trying it.
                if ((judgeError as { fatal?: boolean })?.fatal === true) throw judgeError;
                if (transcriptMatches) {
                    // The words are right and only the reading was in
                    // question. Losing the card over a judge outage would be
                    // worse than shipping audio whose reading is unverified,
                    // but say which one happened.
                    log.warn(`Audio judge unavailable (${messageOf(judgeError)}); accepting "${spoken}" on transcript equality with its reading unverified`);
                    return audioBuffer;
                }
                // Audio judge unavailable - fall back to judging the
                // transcript so a judge outage doesn't take down card
                // creation entirely.
                log.warn(`Audio judge failed (${messageOf(judgeError)}); falling back to transcript judge`);
                const textVerdict = await parseCompletion<{ matches: boolean }>(
                    ctx,
                    "You judge whether an automatic speech transcription plausibly comes from audio of an expected phrase. The transcriber may normalize punctuation, numerals vs words, spacing, and casing, and for some languages it outputs a different script or a translation of what was actually said - those still count as a match when the spoken content is plausibly the expected phrase. Count it as a mismatch when the transcription indicates different, missing, or extra spoken content.",
                    `Expected phrase (language: ${language}): "${spoken}"\nTranscription: "${transcript}"\nCould this transcription plausibly come from audio of the expected phrase?`,
                    TRANSCRIPTION_MATCH_FORMAT,
                );
                verdict = { matches: textVerdict.matches, heard: transcript, reason: 'transcript-based fallback judgement' };
            }

            if (verdict.matches) {
                return audioBuffer;
            }

            lastFailure = `judge heard: "${verdict.heard}"; transcript: "${transcript}"; reason: ${verdict.reason}`;
            log.warn(`Audio validation attempt ${attempt}/${maxAttempts} (voice ${voice}) failed for "${spoken}" (${language}); ${lastFailure}`);
        } catch (audioError) {
            if ((audioError as { fatal?: boolean })?.fatal === true) throw audioError;
            lastFailure = messageOf(audioError);
            log.error(`Audio generation attempt ${attempt}/${maxAttempts} failed: ${lastFailure}`);
        }
    }

    throw new Error(`Failed to generate valid audio for "${spoken}" after ${maxAttempts} attempts (${lastFailure})`);
}

// ========================
// CARD TEXT
// ========================

/** The card as this module hands it back; the caller owns the language codes. */
export interface CardText {
    front_text: string;
    back_text: string;
    /** Reading of back_text in its own script (never romanised), '' unless the script hides the reading. */
    spoken_reading: string;
}

export interface CardTextRequest {
    /** What the learner typed. Required to generate a card, optional when rewriting one. */
    userInput?: string;
    /** Which language the input is in, when the caller can tell for certain
     *  (by script). Omitted means "you work it out". */
    inputLanguage?: 'known' | 'learning';
    /** The language the learner already speaks; the front of every card. */
    knownLanguage: string;
    /** The language being learned; the back of every card. */
    learningLanguage: string;
    /** The card being rewritten, or null when generating a new one. */
    currentCard?: CardText | null;
    /** Card fields the learner rejected: 'front_text', 'back_text', or neither. */
    regenerateParts?: readonly string[];
}

interface KnownSideFields {
    known_text: string;
    sense_tag: string;
    register: string;
}

export type CardTextMode = 'generate' | 'known_side' | 'learning_side' | 'both_sides' | 'none';

/**
 * Which generation the request asks for. Exported because the caller has to
 * know whether a card is about to be written from scratch before it charges
 * for it: a full generation implies new audio on both sides.
 */
export function cardTextMode(regenerateParts: readonly string[] = [], hasCard = false): CardTextMode {
    if (regenerateParts.length === 0 && !hasCard) return 'generate';
    if (!hasCard) return 'none';

    const known = regenerateParts.includes('front_text');
    const learning = regenerateParts.includes('back_text');
    if (known && learning) return 'both_sides';
    if (known) return 'known_side';
    if (learning) return 'learning_side';
    return 'none';
}

/**
 * Writes the two sides of a card, or rewrites the side the learner rejected.
 *
 * Every path goes through assembleCard/composeKnownSide, so whatever the model
 * returns, the learning side ends up a bare utterance and the labels end up on
 * the known side.
 */
export async function generateCardText(
    ctx: CardGenerationContext,
    request: CardTextRequest,
): Promise<CardText> {
    const { knownLanguage, learningLanguage, userInput = '', inputLanguage } = request;
    const current = request.currentCard ?? null;
    const mode = cardTextMode(request.regenerateParts ?? [], Boolean(current));

    let card: { front_text: string; back_text: string } | null = current
        ? { front_text: current.front_text, back_text: current.back_text }
        : null;

    // Romanisation of the back side, used to steer and to check the audio for
    // scripts that leave the reading open. The caller hands back whatever the
    // last generation returned, so regenerating only the audio of a card still
    // in the modal keeps its reading; a card loaded from the database has none.
    let spokenReading = (current?.spoken_reading || '').trim();

    // Case 1: Complete regeneration or new card generation
    if (mode === 'generate') {
        const { assembled } = await generateSpeakableSide(
            ctx,
            CARD_GENERATION_SYSTEM_PROMPT,
            buildCardGenerationPrompt({
                userInput,
                knownLanguage,
                learningLanguage,
                inputLanguage
            }),
            GENERATED_CARD_FORMAT,
            learningLanguage
        );
        card = {
            front_text: assembled.front_text,
            back_text: assembled.back_text,
        };
        spokenReading = assembled.spoken_reading;
    }
    // Case 2: Regenerate only the known side (the learning side stays put)
    else if (mode === 'known_side' && card) {
        const rewritten = await parseCompletion<KnownSideFields>(
            ctx,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildKnownSideRegenerationPrompt({
                knownLanguage,
                learningLanguage,
                learningText: card.back_text,
                rejectedKnownText: card.front_text
            }),
            KNOWN_SIDE_FORMAT,
        );
        card.front_text = composeKnownSide(rewritten.known_text, [
            rewritten.sense_tag,
            registerTag(learningLanguage, rewritten.register)
        ]);
    }
    // Case 3: Regenerate only the learning side
    else if (mode === 'learning_side' && card) {
        const { fields, assembled } = await generateSpeakableSide(
            ctx,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildLearningSideRegenerationPrompt({
                knownLanguage,
                learningLanguage,
                knownText: card.front_text,
                rejectedLearningText: card.back_text,
                userInput
            }),
            LEARNING_SIDE_FORMAT,
            learningLanguage
        );
        card.back_text = assembled.back_text;
        spokenReading = assembled.spoken_reading;
        // The learner's own front wording is kept; only its labels are
        // recomposed, because a sense or register label that still describes
        // the old back text is worse than no label at all.
        card.front_text = composeKnownSide(card.front_text, [
            fields.sense_tag,
            registerTag(learningLanguage, fields.register)
        ]);
    }
    // Case 4: Regenerate both sides
    else if (mode === 'both_sides' && card) {
        const { assembled } = await generateSpeakableSide(
            ctx,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildBothSidesRegenerationPrompt({
                knownLanguage,
                learningLanguage,
                knownText: card.front_text,
                learningText: card.back_text,
                userInput
            }),
            GENERATED_CARD_FORMAT,
            learningLanguage
        );
        card.front_text = assembled.front_text;
        card.back_text = assembled.back_text;
        spokenReading = assembled.spoken_reading;
    }

    if (!card) {
        throw new Error('Failed to generate or retrieve card data');
    }

    return {
        front_text: card.front_text,
        back_text: card.back_text,
        spoken_reading: spokenReading,
    };
}
