/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { zodResponseFormat } from "npm:openai@^6.5.0/helpers/zod";
import { toFile } from "npm:openai@^6.5.0";
import { z } from "npm:zod@^3.25.0";
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage, refundUsage } from "../_shared/billing.ts";
import { createOpenAIClient, TEXT_MODEL, TTS_MODEL, TRANSCRIBE_MODEL, SPEECH_EVALUATION_MODEL } from "../_shared/openai.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import {
    assembleCard,
    composeKnownSide,
    normalizeForComparison,
    normalizeLanguageCode,
    readingIsAmbiguous,
    registerTag,
    spokenForm,
    transcriptionLanguage,
    type AssembledCard,
    type GeneratedCardFields,
} from "../_shared/cardText.ts";
import {
    CARD_GENERATION_SYSTEM_PROMPT,
    CARD_REGENERATION_SYSTEM_PROMPT,
    buildBothSidesRegenerationPrompt,
    buildCardGenerationPrompt,
    buildKnownSideRegenerationPrompt,
    buildLearningSideRegenerationPrompt,
    buildUnspeakableRetryPrompt,
} from "../_shared/cardPrompts.ts";

// ========================
// TTS INSTRUCTIONS
// ========================
// The card text prompts live in ../_shared/cardPrompts.ts; what is left here
// is how the voice should read what those prompts produce. The two are
// coupled: LANGUAGE_VARIETIES in cardText.ts promises the learner the same
// variety these instructions ask the voice for.

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
function getTtsInstructions(language: string): string {
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

const senseTagField = z.string().describe("Two or three words in the learner's own language naming which meaning of the input this card teaches, for example 'calendar day'. Empty when the input has only one everyday meaning.");
const registerField = z.enum(["casual", "polite", "formal"]).describe("The politeness level the learning-language text actually uses");
const spokenReadingField = z.string().describe("How the learning-language text must be read aloud, romanised. Empty unless the writing system leaves the reading open (Japanese, Chinese).");

const GeneratedCardSchema = z.object({
    known_text: z.string().describe("The known-language side: one natural utterance, no annotation of any kind"),
    learning_text: z.string().describe("The learning-language side: one natural utterance in one sense, no annotation of any kind"),
    sense_tag: senseTagField,
    register: registerField,
    spoken_reading: spokenReadingField
});

const LearningSideSchema = z.object({
    learning_text: z.string().describe("The rewritten learning-language side: one natural utterance in one sense, no annotation of any kind"),
    sense_tag: senseTagField,
    register: registerField,
    spoken_reading: spokenReadingField
});

const KnownSideSchema = z.object({
    known_text: z.string().describe("The rewritten known-language side: one natural utterance, no annotation of any kind"),
    sense_tag: senseTagField,
    register: registerField
});

interface Flashcard {
    front_text: string;
    back_text: string;
    front_lang: string;
    back_lang: string;
}

/**
 * Runs a structured-output chat completion and returns the parsed object.
 */
async function parseCompletion<T>(
    openai: ReturnType<typeof createOpenAIClient>,
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    schemaName: string,
): Promise<T> {
    const completion = await openai.chat.completions.parse({
        model: TEXT_MODEL,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        response_format: zodResponseFormat(schema, schemaName),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
        throw new Error(`Failed to parse ${schemaName} from model response`);
    }
    return parsed;
}

/**
 * Runs the structured-output call and, when the model breaks the speakable
 * rule (a gloss, two senses, a slash alternative), tells it what it broke and
 * asks once more. The repaired text from cardText is the floor, not the goal:
 * repairing keeps whichever sense came first, while a corrected model picks
 * the sense a learner meant.
 */
async function generateSpeakableSide<T extends GeneratedCardFields>(
    openai: ReturnType<typeof createOpenAIClient>,
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    schemaName: string,
    learningLanguage: string,
): Promise<{ fields: T; assembled: AssembledCard }> {
    let prompt = userPrompt;
    let last: { fields: T; assembled: AssembledCard } | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const fields = await parseCompletion(openai, systemPrompt, prompt, schema, schemaName);
        const assembled = assembleCard(fields, learningLanguage);
        last = { fields, assembled };

        if (!assembled.repairedReason) return last;

        console.warn(`Unspeakable ${learningLanguage} text on attempt ${attempt}/2: "${fields.learning_text}" (${assembled.repairedReason})`);
        prompt = buildUnspeakableRetryPrompt(userPrompt, fields.learning_text, assembled.repairedReason);
    }

    console.warn(`Model kept returning unspeakable text; using the repaired form "${last!.assembled.back_text}"`);
    return last!;
}

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
    openai: ReturnType<typeof createOpenAIClient>,
    audioBuffer: ArrayBuffer,
    text: string,
    language: string,
    reading = ''
): Promise<AudioVerdict> {
    const readingLine = reading
        ? `\nIt must be read aloud as: ${reading}. This writing system allows more than one reading of the same characters, so a different reading is a mismatch.`
        : '';

    const response = await openai.chat.completions.create({
        model: SPEECH_EVALUATION_MODEL,
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

    const verdict = JSON.parse(toolCall.function.arguments);
    return {
        matches: verdict.matches === true,
        heard: String(verdict.heard ?? ''),
        reason: String(verdict.reason ?? '')
    };
}

// Retrying with the same voice tends to repeat a systematic mispronunciation;
// rotating voices lets retries actually explore.
const TTS_VOICES = ["alloy", "nova", "echo"] as const;

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
 *     starter-deck backfill) carries no reading, because no card column
 *     stores one. Those fall back to the transcript check and are logged.
 *   - The judge is a model from the same vendor as the synthesiser, so a
 *     systematic mispronunciation both share would pass.
 *
 * Fails closed: if no attempt produces audio that passes validation, throws.
 */
async function validateAndGenerateAudio(
    openai: ReturnType<typeof createOpenAIClient>,
    text: string,
    language: string,
    reading = '',
    maxAttempts = 3
): Promise<ArrayBuffer> {
    const spoken = spokenForm(text);
    // A reading is only meaningful where the script hides one.
    const expectedReading = readingIsAmbiguous(language) ? reading.trim() : '';
    const readingMustBeHeard = expectedReading.length > 0;
    let lastFailure = '';

    if (!readingMustBeHeard && readingIsAmbiguous(language)) {
        console.warn(`No expected reading for "${spoken}" (${language}); the transcript check cannot tell which reading was spoken`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const audioMp3 = await openai.audio.speech.create({
                model: TTS_MODEL,
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

            const transcription = await openai.audio.transcriptions.create({
                model: TRANSCRIBE_MODEL,
                file: await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' }),
                language: transcriptionLanguage(language),
            });
            const transcript = transcription.text ?? '';
            const transcriptMatches = normalizeForComparison(transcript) === normalizeForComparison(spoken);

            if (transcriptMatches && !readingMustBeHeard) {
                return audioBuffer;
            }

            let verdict: AudioVerdict;
            try {
                verdict = await judgeAudio(openai, audioBuffer, spoken, language, expectedReading);
            } catch (judgeError) {
                if (transcriptMatches) {
                    // The words are right and only the reading was in
                    // question. Losing the card over a judge outage would be
                    // worse than shipping audio whose reading is unverified,
                    // but say which one happened.
                    console.warn(`Audio judge unavailable (${judgeError.message}); accepting "${spoken}" on transcript equality with its reading unverified`);
                    return audioBuffer;
                }
                // Audio judge unavailable - fall back to judging the
                // transcript so a judge outage doesn't take down card
                // creation entirely.
                console.warn(`Audio judge failed (${judgeError.message}); falling back to transcript judge`);
                const textVerdict = await parseCompletion(
                    openai,
                    "You judge whether an automatic speech transcription plausibly comes from audio of an expected phrase. The transcriber may normalize punctuation, numerals vs words, spacing, and casing, and for some languages it outputs a different script or a translation of what was actually said - those still count as a match when the spoken content is plausibly the expected phrase. Count it as a mismatch when the transcription indicates different, missing, or extra spoken content.",
                    `Expected phrase (language: ${language}): "${spoken}"\nTranscription: "${transcript}"\nCould this transcription plausibly come from audio of the expected phrase?`,
                    z.object({ matches: z.boolean() }),
                    "transcription_match"
                );
                verdict = { matches: textVerdict.matches, heard: transcript, reason: 'transcript-based fallback judgement' };
            }

            if (verdict.matches) {
                return audioBuffer;
            }

            lastFailure = `judge heard: "${verdict.heard}"; transcript: "${transcript}"; reason: ${verdict.reason}`;
            console.warn(`Audio validation attempt ${attempt}/${maxAttempts} failed for "${spoken}" (${language}); ${lastFailure}`);
        } catch (audioError) {
            lastFailure = audioError.message;
            console.error(`Audio generation attempt ${attempt}/${maxAttempts} failed:`, audioError.message);
        }
    }

    throw new Error(`Failed to generate valid audio for "${spoken}" after ${maxAttempts} attempts (${lastFailure})`);
}

/**
 * Handles the complete audio generation process for a card side
 * including validation, old file cleanup, and storage
 */
async function processCardAudio(
    openai: ReturnType<typeof createOpenAIClient>,
    text: string,
    language: string,
    oldAudioPath: string | undefined,
    side: 'front' | 'back',
    reading = ''
): Promise<string> {
    const audioBuffer = await validateAndGenerateAudio(openai, text, language, reading);

    // Delete old audio if it exists; failure to clean up shouldn't fail the request.
    if (oldAudioPath) {
        const { error: deleteError } = await supabaseAdmin.storage
            .from('card-audio')
            .remove([oldAudioPath]);
        if (deleteError) {
            console.warn(`Could not delete old ${side} audio ${oldAudioPath}:`, deleteError.message);
        }
    }

    const audioPath = `${Date.now()}_${side}_${crypto.randomUUID().slice(0, 8)}.mp3`;
    const { error } = await supabaseAdmin.storage
        .from('card-audio')
        .upload(audioPath, audioBuffer, {
            contentType: 'audio/mpeg',
            cacheControl: '3600'
        });

    if (error) {
        throw new Error(`Failed to upload ${side} audio: ${error.message}`);
    }

    return audioPath;
}

Deno.serve(wrapRequest(async ({ user, body }) => {
    const {
        user_input,
        known_language,
        learning_language,
        regenerate_parts = [],
        current_card = null
    } = body as {
        user_input?: string;
        known_language?: string;
        learning_language?: string;
        regenerate_parts?: string[];
        current_card?: Record<string, string> | null;
    };

    // The direction is fixed by the deck, not by the model: the front is the
    // language the learner already speaks, the back the one they are learning.
    const frontLang = normalizeLanguageCode(known_language || current_card?.front_lang || 'en') || 'en';
    const backLang = normalizeLanguageCode(learning_language || current_card?.back_lang || 'en') || 'en';

    let card: Flashcard | null = current_card ? {
        front_text: current_card.front_text,
        back_text: current_card.back_text,
        front_lang: frontLang,
        back_lang: backLang
    } : null;

    // Romanisation of the back side, used to steer and to check the audio for
    // scripts that leave the reading open. The client hands back whatever the
    // last generation returned, so regenerating only the audio of a card still
    // in the modal keeps its reading; a card loaded from the database has none.
    let spokenReading = (current_card?.spoken_reading || '').trim();

    let frontAudioPath = current_card?.front_audio_path;
    let backAudioPath = current_card?.back_audio_path;

    // Track old audio paths for deletion
    const oldFrontAudioPath = current_card?.front_audio_path;
    const oldBackAudioPath = current_card?.back_audio_path;

    // Determine what needs to be regenerated
    const needsFullRegeneration = regenerate_parts.length === 0 && !card;
    const needsFrontTextRegeneration = regenerate_parts.includes('front_text');
    const needsBackTextRegeneration = regenerate_parts.includes('back_text');
    const needsFrontAudioRegeneration = regenerate_parts.includes('front_audio_path') || needsFrontTextRegeneration || needsFullRegeneration;
    const needsBackAudioRegeneration = regenerate_parts.includes('back_audio_path') || needsBackTextRegeneration || needsFullRegeneration;

    // Reject empty generation requests before any billing or API calls.
    // (wrapRequest tolerates a missing body, so this is the real gate.)
    if (needsFullRegeneration && !user_input?.trim()) {
        throw new Error('user_input is required to generate a card');
    }

    // Check audio generation limits BEFORE making any API calls
    const audioToGenerate = (needsFrontAudioRegeneration ? 1 : 0) + (needsBackAudioRegeneration ? 1 : 0);

    if (audioToGenerate > 0) {
        const { allowed } = await checkAndIncrementUsage(
            user.id,
            'card_audio_generations_used',
            audioToGenerate
        );

        if (!allowed) {
            throw new HttpError('You have reached your audio generation limit for this billing period', 403);
        }
    }

    const openai = createOpenAIClient();

    // Case 1: Complete regeneration or new card generation
    if (needsFullRegeneration) {
        const { assembled } = await generateSpeakableSide(
            openai,
            CARD_GENERATION_SYSTEM_PROMPT,
            buildCardGenerationPrompt({
                userInput: user_input || '',
                knownLanguage: frontLang,
                learningLanguage: backLang
            }),
            GeneratedCardSchema,
            "flashcard_generation",
            backLang
        );
        card = {
            front_text: assembled.front_text,
            back_text: assembled.back_text,
            front_lang: frontLang,
            back_lang: backLang
        };
        spokenReading = assembled.spoken_reading;
    }
    // Case 2: Regenerate only the known side (the learning side stays put)
    else if (needsFrontTextRegeneration && !needsBackTextRegeneration && card) {
        const rewritten = await parseCompletion(
            openai,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildKnownSideRegenerationPrompt({
                knownLanguage: frontLang,
                learningLanguage: backLang,
                learningText: card.back_text,
                rejectedKnownText: card.front_text
            }),
            KnownSideSchema,
            "known_side_regeneration"
        );
        card.front_text = composeKnownSide(rewritten.known_text, [
            rewritten.sense_tag,
            registerTag(backLang, rewritten.register)
        ]);
    }
    // Case 3: Regenerate only the learning side
    else if (needsBackTextRegeneration && !needsFrontTextRegeneration && card) {
        const { fields, assembled } = await generateSpeakableSide(
            openai,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildLearningSideRegenerationPrompt({
                knownLanguage: frontLang,
                learningLanguage: backLang,
                knownText: card.front_text,
                rejectedLearningText: card.back_text,
                userInput: user_input || ''
            }),
            LearningSideSchema,
            "learning_side_regeneration",
            backLang
        );
        card.back_text = assembled.back_text;
        spokenReading = assembled.spoken_reading;
        // The learner's own front wording is kept; only its labels are
        // recomposed, because a sense or register label that still describes
        // the old back text is worse than no label at all.
        card.front_text = composeKnownSide(card.front_text, [
            fields.sense_tag,
            registerTag(backLang, fields.register)
        ]);
    }
    // Case 4: Regenerate both sides
    else if (needsFrontTextRegeneration && needsBackTextRegeneration && card) {
        const { assembled } = await generateSpeakableSide(
            openai,
            CARD_REGENERATION_SYSTEM_PROMPT,
            buildBothSidesRegenerationPrompt({
                knownLanguage: frontLang,
                learningLanguage: backLang,
                knownText: card.front_text,
                learningText: card.back_text,
                userInput: user_input || ''
            }),
            GeneratedCardSchema,
            "both_sides_regeneration",
            backLang
        );
        card.front_text = assembled.front_text;
        card.back_text = assembled.back_text;
        spokenReading = assembled.spoken_reading;
    }

    if (!card) {
        throw new Error('Failed to generate or retrieve card data');
    }

    // The two sides are independent - generate them concurrently. If audio
    // generation ultimately fails, refund the pre-charged quota.
    try {
        [frontAudioPath, backAudioPath] = await Promise.all([
            needsFrontAudioRegeneration
                ? processCardAudio(openai, card.front_text, card.front_lang, oldFrontAudioPath, 'front')
                : Promise.resolve(frontAudioPath),
            needsBackAudioRegeneration
                ? processCardAudio(openai, card.back_text, card.back_lang, oldBackAudioPath, 'back', spokenReading)
                : Promise.resolve(backAudioPath),
        ]);
    } catch (audioError) {
        if (audioToGenerate > 0) {
            await refundUsage(user.id, 'card_audio_generations_used', audioToGenerate);
        }
        throw audioError;
    }

    return {
        card: {
            front_text: card.front_text,
            back_text: card.back_text,
            front_lang: card.front_lang,
            back_lang: card.back_lang,
            front_audio_path: frontAudioPath,
            back_audio_path: backAudioPath,
            // Not a card column: it exists so a follow-up request in the same
            // modal session can still check the reading of the back audio.
            spoken_reading: spokenReading
        }
    };
}));
