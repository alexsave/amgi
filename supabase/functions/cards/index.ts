/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { zodResponseFormat } from "npm:openai@^6.5.0/helpers/zod";
import { toFile } from "npm:openai@^6.5.0";
import { z } from "npm:zod@^3.25.0";
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage, refundUsage } from "../_shared/billing.ts";
import { createOpenAIClient, TEXT_MODEL, TTS_MODEL, TRANSCRIBE_MODEL } from "../_shared/openai.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

// ========================
// PROMPT TEMPLATES
// ========================

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

// Card generation system prompt
const CARD_GENERATION_SYSTEM_PROMPT = "You are a language learning flashcard creator. Your task is to create flashcards where the FRONT is ALWAYS in the user's known language, and the BACK is ALWAYS in the learning language. You'll first detect the language of the input text and then create the appropriate flashcard based on this detection.";

// Card generation user prompt template
// Example: {user_input} = "Hello, how are you?"
// Example: {known_language} = "English"
// Example: {learning_language} = "Spanish"
const CARD_GENERATION_USER_TEMPLATE = `Create a flashcard for language learning following these rules:

1. First, detect the language of this input: "{user_input}"

2. Then create a flashcard where:
   - The FRONT is ALWAYS in {known_language}
   - The BACK is ALWAYS in {learning_language}

3. Use these rules based on detection:
   - If input is in {known_language}: Front = original input, Back = translation to {learning_language}
   - If input is in {learning_language}: Front = translation to {known_language}, Back = original input
   - If input is in any other language: Front = translation to {known_language}, Back = translation to {learning_language}

Return the flashcard with language codes.`;

// Translation system prompt
const TRANSLATION_SYSTEM_PROMPT = "You are a language translation expert. Your task is to translate text accurately while preserving the original meaning, tone, and context.";

// Front text translation user prompt template
const FRONT_TEXT_TRANSLATION_TEMPLATE = `I need a new translation for the front of my flashcard.

1. The back of my flashcard contains this text in {card_back_lang}: "{card_back_text}"

2. Please translate it to {card_front_lang} for the front of the card.

3. I was not satisfied with the previous translation "{card_front_text}", so please make sure your translation is accurate, natural sounding, and preserves the original meaning.

Return only a JSON with the translated front_text.`;

// Back text translation user prompt template
const BACK_TEXT_TRANSLATION_TEMPLATE = `I need a new translation for the back of my flashcard.

1. The front of my flashcard contains this text in {card_front_lang}: "{card_front_text}"

2. Please translate it to {card_back_lang} for the back of the card.

3. I was not satisfied with the previous translation "{card_back_text}", so please make sure your translation is accurate, natural sounding, and preserves the original meaning.

Return only a JSON with the translated back_text.`;

// Both sides improvement system prompt
const BOTH_SIDES_IMPROVEMENT_SYSTEM_PROMPT = "You are a language learning flashcard creator. Your task is to improve existing flashcards by providing better translations.";

// Both sides improvement user prompt template
const BOTH_SIDES_IMPROVEMENT_TEMPLATE = `I need both sides of my flashcard improved.

1. Current flashcard:
   - Front ({card_front_lang}): "{card_front_text}"
   - Back ({card_back_lang}): "{card_back_text}"

2. Please provide improved translations for both sides:
   - The FRONT should be in {card_front_lang}
   - The BACK should be in {card_back_lang}

3. The user was not satisfied with the existing translations, so please make sure your translations are accurate, natural sounding, and preserve the original meaning of "{user_input}".

Return the improved flashcard text for both sides.`;

// ========================
// SCHEMA DEFINITIONS
// ========================

const FlashcardSchema = z.object({
    front_text: z.string().describe("The front of the flashcard"),
    back_text: z.string().describe("The back of the flashcard"),
    front_lang: z.string().describe("The language of the front of the flashcard"),
    back_lang: z.string().describe("The language of the back of the flashcard")
});

type Flashcard = z.infer<typeof FlashcardSchema>;

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
 * Maps app language codes to what the transcription API expects: ISO-639
 * primary subtags, except Cantonese which needs 'yue' — plain 'zh' would
 * make the model transcribe Cantonese TTS audio as Mandarin and fail
 * validation every time.
 */
function transcriptionLanguage(language: string): string {
    const code = language.toLowerCase().replace(/-/g, '_');
    if (code === 'zh_hk') return 'yue';
    return code.split('_')[0];
}

/**
 * Normalizes text for a lenient transcription comparison: lowercase,
 * no punctuation, collapsed whitespace.
 */
function normalizeForComparison(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Validates generated audio by transcribing it and checking it matches the
 * expected text. Cheap exact comparison first; an LLM judge only breaks ties
 * (numerals vs words, transcription variants, etc).
 */
async function validateAndGenerateAudio(
    openai: ReturnType<typeof createOpenAIClient>,
    text: string,
    language: string,
    maxAttempts = 3
): Promise<ArrayBuffer> {
    let lastTranscript = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const audioMp3 = await openai.audio.speech.create({
                model: TTS_MODEL,
                voice: "alloy",
                input: text,
                instructions: getTtsInstructions(language)
            });

            const audioBuffer = await audioMp3.arrayBuffer();

            const transcription = await openai.audio.transcriptions.create({
                model: TRANSCRIBE_MODEL,
                file: await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' }),
                language: transcriptionLanguage(language),
            });
            lastTranscript = transcription.text ?? '';

            if (normalizeForComparison(lastTranscript) === normalizeForComparison(text)) {
                return audioBuffer;
            }

            // Not an exact match — let a text model judge whether the audio
            // still says the right thing (e.g. "2" vs "two").
            const verdict = await parseCompletion(
                openai,
                "You judge whether a speech transcription matches an expected phrase. Minor transcription differences (punctuation, numerals vs words, spacing, casing) still count as a match. Missing, extra, or different words do not.",
                `Expected phrase (${language}): "${text}"\nTranscription: "${lastTranscript}"\nDoes the transcription match the expected phrase?`,
                z.object({ matches: z.boolean() }),
                "transcription_match"
            );

            if (verdict.matches) {
                return audioBuffer;
            }

            console.warn(`Audio validation attempt ${attempt}/${maxAttempts} failed for "${text}" (${language}); transcript: "${lastTranscript}"`);
        } catch (audioError) {
            console.error(`Audio generation attempt ${attempt}/${maxAttempts} failed:`, audioError.message);
        }
    }

    throw new Error(`Failed to generate valid audio for "${text}" after ${maxAttempts} attempts (last transcript: "${lastTranscript}")`);
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
    side: 'front' | 'back'
): Promise<string> {
    const audioBuffer = await validateAndGenerateAudio(openai, text, language);

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

    // Initialize card data and audio paths
    let card: Flashcard | null = current_card ? {
        front_text: current_card.front_text,
        back_text: current_card.back_text,
        front_lang: current_card.front_lang || known_language || 'en',
        back_lang: current_card.back_lang || learning_language || 'en'
    } : null;

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
        card = await parseCompletion(
            openai,
            CARD_GENERATION_SYSTEM_PROMPT,
            replacePlaceholders(CARD_GENERATION_USER_TEMPLATE, {
                user_input: user_input || '',
                known_language: known_language || 'en',
                learning_language: learning_language || 'en'
            }),
            FlashcardSchema,
            "flashcard_generation"
        );
    }
    // Case 2: Regenerate only front text (translate from back text)
    else if (needsFrontTextRegeneration && !needsBackTextRegeneration && card) {
        const translation = await parseCompletion(
            openai,
            TRANSLATION_SYSTEM_PROMPT,
            replacePlaceholders(FRONT_TEXT_TRANSLATION_TEMPLATE, {
                card_back_lang: card.back_lang,
                card_back_text: card.back_text,
                card_front_lang: card.front_lang,
                card_front_text: card.front_text
            }),
            z.object({ front_text: z.string().describe("The translated text for the front of the flashcard") }),
            "front_text_translation"
        );
        card.front_text = translation.front_text;
    }
    // Case 3: Regenerate only back text (translate from front text)
    else if (needsBackTextRegeneration && !needsFrontTextRegeneration && card) {
        const translation = await parseCompletion(
            openai,
            TRANSLATION_SYSTEM_PROMPT,
            replacePlaceholders(BACK_TEXT_TRANSLATION_TEMPLATE, {
                card_front_lang: card.front_lang,
                card_front_text: card.front_text,
                card_back_lang: card.back_lang,
                card_back_text: card.back_text
            }),
            z.object({ back_text: z.string().describe("The translated text for the back of the flashcard") }),
            "back_text_translation"
        );
        card.back_text = translation.back_text;
    }
    // Case 4: Regenerate both front and back text (but not as a new card)
    else if (needsFrontTextRegeneration && needsBackTextRegeneration && card) {
        const improved = await parseCompletion(
            openai,
            BOTH_SIDES_IMPROVEMENT_SYSTEM_PROMPT,
            replacePlaceholders(BOTH_SIDES_IMPROVEMENT_TEMPLATE, {
                card_front_lang: card.front_lang,
                card_front_text: card.front_text,
                card_back_lang: card.back_lang,
                card_back_text: card.back_text,
                user_input: user_input || ''
            }),
            FlashcardSchema,
            "improved_flashcard"
        );
        // Update only the text fields, preserve language info
        card.front_text = improved.front_text;
        card.back_text = improved.back_text;
    }

    if (!card) {
        throw new Error('Failed to generate or retrieve card data');
    }

    // The two sides are independent — generate them concurrently. If audio
    // generation ultimately fails, refund the pre-charged quota.
    try {
        [frontAudioPath, backAudioPath] = await Promise.all([
            needsFrontAudioRegeneration
                ? processCardAudio(openai, card.front_text, card.front_lang, oldFrontAudioPath, 'front')
                : Promise.resolve(frontAudioPath),
            needsBackAudioRegeneration
                ? processCardAudio(openai, card.back_text, card.back_lang, oldBackAudioPath, 'back')
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
            back_audio_path: backAudioPath
        }
    };
}));
