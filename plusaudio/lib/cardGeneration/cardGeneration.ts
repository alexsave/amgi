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
// cardText.ts), the corrective retry for unspeakable text, the TTS voice
// instructions, and the transcribe-then-judge validation loop.
//
// What is NOT in here, and must stay out: authentication, quota, storage,
// the database, environment variables, and any runtime-specific API. The
// OpenAI client and the model ids are injected (see CardGenerationContext)
// so a test can drive the whole policy without a key or a network. Keeping
// the module free of npm: specifiers is what lets Node require it directly,
// with no build step and so no artifact that can drift from its source.

import {
    assembleCard,
    composeKnownSide,
    normalizeForComparison,
    readingIsAmbiguous,
    registerTag,
    spokenForm,
    transcriptionLanguage,
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

// ========================
// THE INJECTED CLIENT
// ========================
//
// Structural types rather than the SDK's own: the retired edge function ran
// npm:openai@6, the CLI runs the Node package, and a test passes neither.
// Only the four calls this module makes are described.

interface ChatToolCall {
    type?: string;
    function?: { name?: string; arguments?: string };
}

interface ChatCompletionLike {
    choices: Array<{
        message?: {
            content?: string | null;
            tool_calls?: ChatToolCall[] | null;
        };
    }>;
}

// The request bodies are the SDK's own parameter types, which live behind an
// npm: specifier this module is not allowed to import. Typing them loosely is
// what lets a real client, a client from a different SDK major, and a test
// double all satisfy the same seam; the bodies themselves are built in one
// place each, a few lines below.
// deno-lint-ignore no-explicit-any
type RequestBody = any;

export interface OpenAIClientLike {
    chat: {
        completions: {
            create(body: RequestBody): Promise<ChatCompletionLike>;
        };
    };
    audio: {
        speech: {
            create(body: RequestBody): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
        };
        transcriptions: {
            create(body: RequestBody): Promise<{ text?: string }>;
        };
    };
}

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
    openai: OpenAIClientLike;
    models: CardModels;
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
// TTS INSTRUCTIONS
// ========================
// The card text prompts live in ./cardPrompts.ts; what is here is how the
// voice should read what those prompts produce. The two are coupled:
// LANGUAGE_VARIETIES in cardText.ts promises the learner the same variety
// these instructions ask the voice for.

/**
 * Utility function to replace placeholders in template strings
 * @param template The template string with {placeholders}
 * @param values Object containing placeholder:value pairs
 * @returns String with all placeholders replaced with their values
 */
function replacePlaceholders(template: string, values: Record<string, string>): string {
    return Object.entries(values).reduce(
        (result, [key, value]) => result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || ''),
        template
    );
}

// Base TTS instruction template
const TTS_INSTRUCTIONS_TEMPLATE = `Speak like a native speaker of {language}. Use proper pronunciation and intonation for language learning purposes.`;

// Language-specific TTS instruction templates
const LANGUAGE_TTS_INSTRUCTIONS: Record<string, string> = {
    // Romance languages
    es: `Habla como un nativo del español con pronunciación clara. Usa patrones de entonación y ritmo castellanos adecuados. Enfatiza el sonido de la 'r' vibrante donde corresponda y mantén los patrones de acentuación correctos en las sílabas.`,

    fr: `Parlez comme un locuteur natif français avec une prononciation authentique. Faites particulièrement attention aux voyelles nasales, à la liaison entre les mots, et aux modèles corrects de rythme et d'intonation. Utilisez les sons 'r' français appropriés et maintenez la qualité musicale de la parole française.`,

    pt: `Fale como um nativo de português com pronúncia adequada. Use entonação apropriada para perguntas e afirmações. Preste atenção aos sons nasais e ao ritmo adequado do português europeu.`,

    it: `Parla come un madrelingua italiano con intonazione melodica. Enfatizza le consonanti doppie (geminazione) dove appropriato, e usa la qualità musicale e il ritmo propri del discorso italiano autentico. Articola chiaramente con i corretti schemi di accentuazione.`,

    // Germanic languages
    en: `Speak in clear, standard English with proper pronunciation. Use natural intonation patterns and rhythm with appropriate stress on syllables. Articulate clearly without exaggeration.`,

    de: `Sprechen Sie wie ein deutscher Muttersprachler mit korrekter Aussprache. Achten Sie besonders auf Umlaute, den 'ch'-Laut und den richtigen Rhythmus der deutschen Sprache. Verwenden Sie angemessene Intonation für Fragen und Aussagen.`,

    // Slavic languages
    ru: `Говорите как носитель русского языка с правильным произношением. Обратите особое внимание на мягкие и твердые согласные, правильные модели ударения, которые могут изменять значение слов, и редуцированные гласные звуки. Поддерживайте соответствующий ритм и интонацию русской речи.`,

    // East Asian languages
    zh_cn: `请像母语为普通话的人一样发音，正确表达四声。特别注意能改变词义的声调质量。使用自然的普通话语言节奏和适当的停顿。`,

    zh_hk: `請像以廣東話為母語的人一樣發音，正確表達六聲。請特別注意聲調質量和正確的廣東話發音。使用自然的廣東話語言節奏和適當的口語表達方式。`,

    ja: `日本語のネイティブスピーカーのように、適切なピッチアクセントで話してください。モーラ拍のリズムに注意し、適切なイントネーションパターンを維持してください。母音を明確に発音し、適切な日本語の音声を使用してください。`,

    ko: `한국어 원어민처럼 정확한 발음으로 말하세요. 받침(종성), 모음 길이, 적절한 억양 패턴에 특히 주의하세요. 한국어 발화의 자연스러운 리듬을 유지하세요.`,

    // Southeast Asian languages
    vi: `Hãy nói như một người bản xứ tiếng Việt với cách phát âm chính xác của sáu thanh điệu. Đặc biệt chú ý đến chất lượng thanh điệu có thể thay đổi ý nghĩa của từ. Sử dụng nhịp điệu tự nhiên của tiếng Việt với các khoảng dừng thích hợp.`,

    th: `พูดเหมือนคนไทยที่มีการออกเสียงที่ถูกต้องของเสียงวรรณยุกต์ทั้งห้า ให้ความสนใจเป็นพิเศษกับคุณภาพเสียงวรรณยุกต์ ความยาวของสระ และพยัญชนะไทยที่เป็นเอกลักษณ์ รักษาจังหวะการพูดภาษาไทยที่เป็นธรรมชาติด้วยการหยุดที่เหมาะสม`,

    id: `Berbicaralah seperti penutur asli bahasa Indonesia dengan pengucapan yang tepat. Perhatikan khusus pada bunyi vokal dan pertahankan pola tekanan yang relatif merata yang menjadi ciri khas bahasa Indonesia. Gunakan intonasi alami untuk pernyataan dan pertanyaan.`,

    // South Asian languages
    hi: `हिंदी के मूल वक्ता की तरह सही उच्चारण के साथ बोलें। मूर्धन्य ध्वनियों, महाप्राण व्यंजनों और दंत्य और मूर्धन्य व्यंजनों के बीच के अंतर पर विशेष ध्यान दें। हिंदी भाषा के स्वाभाविक लय और स्वरोत्तार को बनाए रखें।`,

    ur: `اردو کے مقامی خطیب کی طرح صحیح تلفظ کے ساتھ بولیں۔ گٹکی آوازوں، سانس والے متخرجوں، اور مناسب دباؤ کے پیٹرن پر خصوصی توجہ دیں۔ اردو تقریر کی قدرتی لے اور آہنگ کو برقرار رکھیں۔`,

    // Middle Eastern languages
    ar: `تحدث مثل متحدث اللغة العربية الفصحى الحديثة مع النطق الصحيح. انتبه بشكل خاص إلى الأصوات الحلقية والمفخمة، وطول الحركات المناسب، وأنماط النبر المناسبة. حافظ على إيقاع وتنغيم الكلام العربي الطبيعي.`,

    tr: `Doğru telaffuzla bir Türk anadili konuşmacısı gibi konuşun. Özellikle ünlü uyumuna, genellikle son hecede olan doğru vurguya ve Türkçe'ye özgü seslere dikkat edin. Doğal Türkçe konuşma ritmi ve tonlamasını koruyun.`
};

/**
 * Gets the appropriate TTS instructions for a specific language
 * @param language Language code (e.g., 'en', 'es', 'fr')
 * @returns Specialized instructions if available, or generic instructions with the language name
 */
export function getTtsInstructions(language: string): string {
    const languageCode = language.toLowerCase().replace(/-/g, '_');

    if (LANGUAGE_TTS_INSTRUCTIONS[languageCode]) {
        return LANGUAGE_TTS_INSTRUCTIONS[languageCode];
    }

    return replacePlaceholders(TTS_INSTRUCTIONS_TEMPLATE, { language });
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
// would have silently degraded the TTS instructions and the transcription
// language hint.
//
// Written as JSON Schema rather than built from zod, because zod would be an
// npm: import and this module has to load in Node too. These objects are
// byte-for-byte what zodResponseFormat() produced from the zod schemas they
// replace, down to the $schema key, so the request on the wire is unchanged;
// src/__tests__/edge/cardGeneration.test.js pins them against that output.

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
    type: "json_schema";
    json_schema: {
        name: string;
        strict: true;
        schema: Record<string, unknown>;
    };
}

function responseFormat(name: string, properties: Record<string, unknown>): StructuredResponseFormat {
    return {
        type: "json_schema",
        json_schema: {
            name,
            strict: true,
            schema: {
                type: "object",
                properties,
                required: Object.keys(properties),
                additionalProperties: false,
                $schema: JSON_SCHEMA_DRAFT,
            },
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

/**
 * Runs a structured-output chat completion and returns the parsed object.
 */
async function parseCompletion<T>(
    ctx: CardGenerationContext,
    systemPrompt: string,
    userPrompt: string,
    format: StructuredResponseFormat,
): Promise<T> {
    const completion = await ctx.openai.chat.completions.create({
        model: ctx.models.text,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        response_format: format,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        throw new Error(`Failed to parse ${format.json_schema.name} from model response`);
    }
    return JSON.parse(content) as T;
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

const AUDIO_JUDGE_SYSTEM_PROMPT = `You are a strict quality judge for text-to-speech audio used on language-learning flashcards. You are given the exact phrase the audio must say and the language it must be spoken in, followed by the audio clip. Listen carefully and judge whether the clip:
1. Says exactly the expected phrase - no missing, extra, or different words. Natural readings (numerals read out as words, expanded abbreviations, spoken or skipped punctuation) are acceptable.
2. Is spoken in the expected language with clear, intelligible pronunciation.
3. When an expected reading is given, uses that reading. The written form has more than one possible pronunciation, and reading the same characters a different way is a mismatch even though the words are right.
Judge only what you actually hear in the audio. Call judge_audio with what you heard and your verdict.`;

const audioJudgeTools = [{
    type: "function" as const,
    function: {
        name: "judge_audio",
        description: "Report whether the audio clip says the expected phrase in the expected language",
        parameters: {
            type: "object",
            properties: {
                heard: { type: "string", description: "What the audio actually says, as heard" },
                matches: { type: "boolean", description: "True if the audio says exactly the expected phrase in the expected language with intelligible pronunciation" },
                reason: { type: "string", description: "Brief justification for the verdict" }
            },
            required: ["heard", "matches", "reason"]
        }
    }
}];

interface AudioVerdict {
    matches: boolean;
    heard: string;
    reason: string;
}

/**
 * Judges generated TTS audio by listening to it directly with an audio-input
 * chat model. Unlike a transcription round-trip, this works uniformly for any
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

    const response = await ctx.openai.chat.completions.create({
        model: ctx.models.speechEvaluation,
        messages: [
            { role: "system", content: AUDIO_JUDGE_SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "text", text: `Expected phrase (language: ${language}): "${text}"${readingLine}\nJudge this audio:` },
                    { type: "input_audio", input_audio: { data: arrayBufferToBase64(audioBuffer), format: "mp3" } }
                ]
            }
        ],
        tools: audioJudgeTools,
        tool_choice: { type: "function", function: { name: "judge_audio" } }
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
        throw new Error('No tool call in audio judge response');
    }

    const verdict = JSON.parse(toolCall.function?.arguments ?? '{}');
    return {
        matches: verdict.matches === true,
        heard: String(verdict.heard ?? ''),
        reason: String(verdict.reason ?? '')
    };
}

// Retrying with the same voice tends to repeat a systematic mispronunciation;
// rotating voices lets retries actually explore.
const TTS_VOICES = ["alloy", "nova", "echo"] as const;

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
 * listens for it. Two honest gaps remain, and neither is silent:
 *   - Audio regenerated for an existing card (the modal's audio button, the
 *     starter-deck backfill, every clip plusaudio adds to a deck it did not
 *     write) carries no reading, because no card column stores one. Those
 *     fall back to the transcript check and are logged.
 *   - The judge is a model from the same vendor as the synthesiser, so a
 *     systematic mispronunciation both share would pass.
 *
 * Fails closed: if no attempt produces audio that passes validation, throws.
 */
export async function generateCardAudio(
    ctx: CardGenerationContext,
    { text, language, reading = '', maxAttempts = 3 }: CardAudioRequest,
): Promise<ArrayBuffer> {
    const log = logOf(ctx);
    const spoken = spokenForm(text);
    // A reading is only meaningful where the script hides one.
    const expectedReading = readingIsAmbiguous(language) ? reading.trim() : '';
    const readingMustBeHeard = expectedReading.length > 0;
    let lastFailure = '';

    if (!readingMustBeHeard && readingIsAmbiguous(language)) {
        log.warn(`No expected reading for "${spoken}" (${language}); the transcript check cannot tell which reading was spoken`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const audioMp3 = await ctx.openai.audio.speech.create({
                model: ctx.models.tts,
                voice: TTS_VOICES[(attempt - 1) % TTS_VOICES.length],
                input: spoken,
                // Steering the synthesiser with the reading is cheaper than
                // catching it afterwards, and it helps on exactly the words
                // where the check below is weakest.
                instructions: readingMustBeHeard
                    ? `${getTtsInstructions(language)}\n\nRead the text with exactly this pronunciation: ${expectedReading}`
                    : getTtsInstructions(language)
            });

            const audioBuffer = await audioMp3.arrayBuffer();

            const transcription = await ctx.openai.audio.transcriptions.create({
                model: ctx.models.transcribe,
                file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
                // gpt-transcribe replaces the singular `language` field
                // gpt-4o-mini-transcribe took with a `languages` array (see
                // models.ts) - confirmed against OpenAI's speech-to-text
                // guide, 2026-09-19.
                languages: [transcriptionLanguage(language)],
            });
            const transcript = transcription.text ?? '';
            const transcriptMatches = normalizeForComparison(transcript) === normalizeForComparison(spoken);

            if (transcriptMatches && !readingMustBeHeard) {
                return audioBuffer;
            }

            let verdict: AudioVerdict;
            try {
                verdict = await judgeAudio(ctx, audioBuffer, spoken, language, expectedReading);
            } catch (judgeError) {
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
            log.warn(`Audio validation attempt ${attempt}/${maxAttempts} failed for "${spoken}" (${language}); ${lastFailure}`);
        } catch (audioError) {
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
    const { knownLanguage, learningLanguage, userInput = '' } = request;
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
                learningLanguage
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
