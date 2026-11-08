// Text policy for cards that are meant to be SPOKEN.
//
// Every side of every card in this app is synthesised and played, and the
// learner repeats the learning-language side out loud. That turns three
// things into content decisions rather than formatting details, and this
// module is where they are decided instead of being left to whatever the
// model reaches for:
//
//   1. Register. Korean and Japanese encode the speaker's relationship to the
//      listener in the verb, and most European languages encode it in the
//      second person. Something is chosen on every single card whether or not
//      anyone decided it, so the choice is written down here.
//   2. Sense. One card teaches one meaning. A card that concatenates senses
//      ("날짜 (달력상의 날짜), 데이트 (연애 약속)" - a real generation) has
//      nothing in it that can be said out loud as one utterance.
//   3. Annotation. Anything the learner should read but nobody should say - a
//      sense label, a register marker - belongs on the KNOWN-language side in
//      parentheses, where spokenForm() strips it before synthesis and before
//      the speech evaluator ever sees it. The learning-language side is a
//      bare utterance, always.
//
// Imported by plusaudio/lib/generator.js and, before the replatform, by the
// `cards` and `speech` edge functions (Deno) - which is why it still stays
// free of Deno APIs and of npm:/jsr: imports, even though Node is now its
// only runtime.

/** English names for the app's languages, mirroring src/constants/languages.js. */
export const LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    pt: 'Portuguese',
    it: 'Italian',
    de: 'German',
    ru: 'Russian',
    zh_cn: 'Mandarin Chinese',
    zh_hk: 'Cantonese',
    ja: 'Japanese',
    ko: 'Korean',
    vi: 'Vietnamese',
    th: 'Thai',
    id: 'Indonesian',
    hi: 'Hindi',
    ur: 'Urdu',
    ar: 'Arabic',
    tr: 'Turkish',
};

/** Lowercases and normalises separators: 'zh-HK' and 'zh_hk' are one code. */
export function normalizeLanguageCode(language: string): string {
    return (language || '').toLowerCase().replace(/-/g, '_').trim();
}

/**
 * The model reads names, not codes: 'zh_hk' is not obviously Cantonese and
 * 'ko' is not obviously Korean to a prompt written in English.
 */
export function languageName(language: string): string {
    const code = normalizeLanguageCode(language);
    return LANGUAGE_NAMES[code] || code || 'the target language';
}

/**
 * Maps app language codes to what the transcription API expects: ISO-639
 * primary subtags, except Cantonese which needs 'yue' - plain 'zh' would
 * make the model transcribe Cantonese TTS audio as Mandarin and fail
 * validation every time.
 */
export function transcriptionLanguage(language: string): string {
    const code = normalizeLanguageCode(language);
    if (code === 'zh_hk') return 'yue';
    return code.split('_')[0];
}

export type RegisterLevel = 'casual' | 'polite' | 'formal';

export const REGISTER_LEVELS: RegisterLevel[] = ['casual', 'polite', 'formal'];

interface RegisterPolicy {
    /** What to produce when the input itself does not force another level. */
    defaultLevel: RegisterLevel;
    /** Handed to the generator verbatim. */
    guidance: string;
}

/**
 * Register policy per learning language.
 *
 * Why polite-neutral is the default everywhere: a learner's first real
 * conversations are with strangers - a shopkeeper, a taxi driver, a colleague,
 * a teacher - never with people they are already close to. One notch too
 * polite sounds slightly stiff; one notch too casual is rude, and a beginner
 * cannot yet hear which one they produced. The asymmetry decides it.
 *
 * Why not "whatever the input implies": that is also honoured (every policy
 * below defers to the input when the input carries a relationship), but most
 * input is a bare English phrase that implies nothing, and that is exactly the
 * case the generator used to resolve silently.
 *
 * A language absent from this map is treated as not grammatically marking
 * register: no default to state and nothing to label on the card.
 */
export const REGISTER_POLICIES: Record<string, RegisterPolicy> = {
    ko: {
        defaultLevel: 'polite',
        guidance: `Korean marks politeness in the verb ending, so a level is chosen on every card. Default to 해요체, the polite informal style (-요 / -아요 / -어요, questions in -요?): it is what an adult uses with a stranger of any age without sounding either rude or ceremonial. Use 반말 (plain style) only when the input is itself in 반말 or explicitly says it is for a close friend, and use 합쇼체 (-습니다 / -십시오) only where it is the fixed normal form of the expression (감사합니다, 죄송합니다, 안녕하세요) or the input is explicitly a formal or service-industry line. Keep one level across the whole utterance.`,
    },
    ja: {
        defaultLevel: 'polite',
        guidance: `Japanese marks politeness in the verb, so a level is chosen on every card. Default to the です／ます style (丁寧語): it is usable with a stranger, a colleague or a teacher without offence. Use plain / dictionary-form endings only when the input is itself in plain form or explicitly says it is for a close friend, and use 尊敬語 or 謙譲語 only when the input is explicitly about serving or addressing a customer or a superior. Keep one level across the whole utterance.`,
    },
    es: {
        defaultLevel: 'polite',
        guidance: `Spanish chooses a second person on every card that addresses someone. Default to usted (with third-person verb agreement) for a single listener, which is safe with a stranger. Use tú when the input itself implies closeness (a friend, a child, a term of endearment, "I love you").`,
    },
    fr: {
        defaultLevel: 'polite',
        guidance: `French chooses a second person on every card that addresses someone. Default to vous for a single listener, which is what a stranger expects. Use tu only when the input itself implies closeness (a friend, a child, a term of endearment).`,
    },
    de: {
        defaultLevel: 'polite',
        guidance: `German chooses a second person on every card that addresses someone. Default to Sie, which is what a stranger expects. Use du only when the input itself implies closeness (a friend, a child, a family member).`,
    },
    it: {
        defaultLevel: 'polite',
        guidance: `Italian chooses a second person on every card that addresses someone. Default to Lei (third-person agreement) for a single listener. Use tu only when the input itself implies closeness.`,
    },
    pt: {
        defaultLevel: 'polite',
        guidance: `European Portuguese chooses a form of address on every card that addresses someone. Default to the polite third person (o senhor / a senhora, or the bare third-person verb without a pronoun), which is what a stranger expects in Portugal. Use tu only when the input itself implies closeness. Avoid bare "você", which is not neutral in European Portuguese.`,
    },
    ru: {
        defaultLevel: 'polite',
        guidance: `Russian chooses a second person on every card that addresses someone. Default to вы for a single listener. Use ты only when the input itself implies closeness (a friend, a child, a family member).`,
    },
    tr: {
        defaultLevel: 'polite',
        guidance: `Turkish chooses a second person on every card that addresses someone. Default to siz for a single listener. Use sen only when the input itself implies closeness.`,
    },
    vi: {
        defaultLevel: 'polite',
        guidance: `Vietnamese encodes the relationship in the pronouns themselves. Default to tôi for the speaker and anh / chị for an adult listener, which is neutral and safe with a stranger. Follow the input when it names the relationship (em, bạn, con, ông, bà).`,
    },
    hi: {
        defaultLevel: 'polite',
        guidance: `Hindi chooses a second person on every card that addresses someone. Default to आप with plural-verb agreement. Use तुम only when the input itself implies closeness, and never तू.`,
    },
    ur: {
        defaultLevel: 'polite',
        guidance: `Urdu chooses a second person on every card that addresses someone. Default to آپ with plural-verb agreement. Use تم only when the input itself implies closeness, and never تو.`,
    },
    id: {
        defaultLevel: 'polite',
        guidance: `Indonesian chooses a form of address on every card that addresses someone. Default to Anda for a single listener, and saya for the speaker. Use kamu / aku only when the input itself implies closeness.`,
    },
    ar: {
        defaultLevel: 'polite',
        guidance: `Write Modern Standard Arabic in its neutral register. When the addressee's gender is not given by the input, use the masculine singular, which is the unmarked form.`,
    },
    th: {
        defaultLevel: 'polite',
        guidance: `Thai marks politeness with a sentence-final particle that depends on the SPEAKER's gender, and this app does not know the learner's gender, so do not assign one: include ครับ / ค่ะ only where the particle is part of the fixed expression itself (สวัสดีครับ, ขอบคุณครับ), and otherwise write the polite-neutral sentence without a final particle rather than guessing. Address the listener as คุณ.`,
    },
};

/**
 * Whether the learning language grammatically encodes politeness, and so
 * whether a register label on the known side carries any information.
 */
export function marksRegister(language: string): boolean {
    return Boolean(REGISTER_POLICIES[normalizeLanguageCode(language)]);
}

export function defaultRegisterLevel(language: string): RegisterLevel | null {
    return REGISTER_POLICIES[normalizeLanguageCode(language)]?.defaultLevel ?? null;
}

export function registerGuidance(language: string): string {
    const policy = REGISTER_POLICIES[normalizeLanguageCode(language)];
    if (policy) return policy.guidance;
    return `If ${languageName(language)} marks politeness or formality grammatically, use the neutral-polite level an adult can use with a stranger, and keep one level across the whole utterance.`;
}

/**
 * The register label for the known side, or null when it would say nothing:
 * either the language does not mark register, or the card came out at the
 * default this app already promises, in which case labelling every card
 * "(polite)" is noise the learner learns to ignore.
 */
export function registerTag(language: string, level: string | null | undefined): string | null {
    const policy = REGISTER_POLICIES[normalizeLanguageCode(language)];
    if (!policy || !level) return null;
    const normalized = level.trim().toLowerCase();
    if (!REGISTER_LEVELS.includes(normalized as RegisterLevel)) return null;
    return normalized === policy.defaultLevel ? null : normalized;
}

/**
 * Variety of the language to write. These must agree with the per-language TTS
 * instructions in cards/index.ts: if the text is Brazilian and the voice is
 * European, the card teaches two different languages at once.
 */
export const LANGUAGE_VARIETIES: Record<string, string> = {
    es: 'European Spanish as spoken in Spain (the voice that reads this card is Castilian).',
    pt: 'European Portuguese as spoken in Portugal (the voice that reads this card is European).',
    ar: 'Modern Standard Arabic, not a regional dialect (the voice that reads this card speaks MSA).',
    zh_cn: 'Mandarin as spoken on the mainland, written in simplified characters.',
    zh_hk: 'Colloquial Cantonese as spoken in Hong Kong, written the way it is spoken (traditional characters, Cantonese vocabulary and particles - not Standard Written Chinese).',
    ja: 'Standard Tokyo Japanese.',
    ko: 'Standard Seoul Korean.',
    en: 'Neutral, widely understood English.',
};

export function varietyGuidance(language: string): string | null {
    return LANGUAGE_VARIETIES[normalizeLanguageCode(language)] ?? null;
}

/**
 * Writing systems where the spelling does not determine the reading, so audio
 * cannot be validated by comparing transcribed text with expected text:
 * Japanese 行った is itta or okonatta, Chinese 行 is xíng or háng, and both
 * transcribe back to the same characters. Hangul and every alphabet in this
 * app are phonemic, so for them the written form IS the reading.
 */
export const READING_OPAQUE_LANGUAGES = ['ja', 'zh_cn', 'zh_hk'];

export function readingIsAmbiguous(language: string): boolean {
    return READING_OPAQUE_LANGUAGES.includes(normalizeLanguageCode(language));
}

/**
 * Native-script detector for the app's non-Latin-script languages, used only
 * for the romanisation GUARD below - a different, narrower job than
 * READING_OPAQUE_LANGUAGES above (which is about which languages need a
 * spoken_reading at all). Korean is phonemic and not reading-opaque, but it
 * is very much not Latin script, and a note that is supposed to teach Hangul
 * but reads "annyeonghaseyo" is exactly the failure this guard exists to
 * catch.
 */
const NATIVE_SCRIPT_PATTERNS: Record<string, RegExp> = {
    ko: /\p{Script=Hangul}/u,
    ja: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u,
    zh_cn: /\p{Script=Han}/u,
    zh_hk: /\p{Script=Han}/u,
    ru: /\p{Script=Cyrillic}/u,
    ar: /\p{Script=Arabic}/u,
    ur: /\p{Script=Arabic}/u,
    hi: /\p{Script=Devanagari}/u,
    th: /\p{Script=Thai}/u,
};

export function usesNonLatinScript(language: string): boolean {
    return normalizeLanguageCode(language) in NATIVE_SCRIPT_PATTERNS;
}

/**
 * The owner's rule, restated for text that ENTERS the system already
 * written rather than text a model generates: "if you're learning a
 * language, you use that language to read it." A model generation is
 * already covered - CARD_GENERATION_SYSTEM_PROMPT's speakingRules() rule 1
 * forbids romanisation outright - so this exists for the paths that never
 * go through that prompt at all: a hand-authored note (the add-note form,
 * a bridge POST/PATCH typed by hand, or an .apkg someone built outside
 * amgi) and plusaudio's own CLI reading one of those decks.
 *
 * This is a soft SIGNAL, not a rule: an English loanword, a proper noun, or
 * deliberate code-switching can legitimately leave a non-Latin-script field
 * entirely in Latin letters, so callers should warn a human rather than
 * refuse the text outright (see notes.js's addNote/updateNoteFields and
 * bridge_ops.py's add_note/update_note for where this is wired in as a
 * warning, never an error). Mixed text - a gloss in parentheses, a reading
 * hint - is deliberately NOT flagged: this only fires when the language's
 * own script is entirely absent from the field.
 */
export function looksRomanized(text: string, language: string): boolean {
    if (!usesNonLatinScript(language)) return false;
    const trimmed = (text || '').trim();
    if (!trimmed) return false;
    if (hasNativeScript(trimmed, language)) return false;
    return /[a-zA-Z]/.test(trimmed);
}

/**
 * Whether `text` contains any of `language`'s own script at all.
 *
 * Deliberately "any", not "mostly": a Korean line with an English phrase
 * inside it - a song lyric ending "still with you", a borrowed brand name -
 * is still Korean, and treating it as English is exactly the mistake this
 * exists to catch. Callers that need to decide which of two strings is the
 * learning-language one should compare both with this rather than trust a
 * model's own idea of which side it was writing.
 *
 * False for a Latin-script language, because the question is unanswerable
 * there: Spanish and English share an alphabet, so nothing about the
 * characters can separate them.
 */
export function hasNativeScript(text: string, language: string): boolean {
    const pattern = NATIVE_SCRIPT_PATTERNS[normalizeLanguageCode(language)];
    if (!pattern) return false;
    return pattern.test((text || '').trim());
}

/**
 * Reading systems for the writing systems in READING_OPAQUE_LANGUAGES, kept
 * in the learner's own script rather than romanised.
 *
 * The owner's rule, stated plainly: if you're learning a language, you use
 * that language to read it. A learner of Japanese who has not yet learned
 * kana has not yet learned enough Japanese to be shown romaji as a reading
 * aid - and kana is also the better TTS pronunciation hint of the two,
 * because it fixes the reading (a kanji compound can hide more than one) the
 * same way spoken_reading needs it fixed, without teaching a Latin-alphabet
 * crutch the learner will need to unlearn. Hiragana is used for the reading
 * even where the headword is written with kanji: it is the one script every
 * Japanese learner reads before any other, the same role zhuyin/bopomofo
 * plays for a Mandarin learner who has not yet committed to pinyin.
 */
const READING_SYSTEMS: Record<string, string> = {
    ja: 'hiragana (for example 行った read as one word: "いった" - never romaji)',
    zh_cn: 'Zhuyin/Bopomofo (注音符号) with tone marks (for example "ㄒㄧㄥˊ ㄌㄜ˙" - never pinyin)',
    zh_hk: 'Cantonese Bopomofo (粵語注音符號) - never Jyutping or Yale romanization',
};

export function readingSystem(language: string): string | null {
    return READING_SYSTEMS[normalizeLanguageCode(language)] ?? null;
}

// ========================
// TEXT SHAPING
// ========================

/** Collapses whitespace and removes the space a stripped annotation leaves in front of punctuation. */
function tidy(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.!?;:、。！？，；：])/g, '$1')
        .replace(/^[\s,、，;；:：.。!！?？/|]+/, '')
        .replace(/[\s,、，;；:：/|]+$/, '')
        .trim();
}

function stripAnnotations(text: string): string {
    return text
        .replace(/[（(][^（()）]*[）)]/g, ' ')
        .replace(/[［[][^［[\]］]*[］\]]/g, ' ');
}

/**
 * Derives the spoken form of card text. Parenthesized/bracketed annotations
 * - sense labels, register markers, readings, usage notes like "date
 * (calendar day)" or "行く [いく]" - are for the learner's eyes, not the
 * voice: speaking them repeats the headword or reads metadata aloud, and then
 * fails validation too. Falls back to the original text when stripping would
 * leave nothing to say.
 */
export function spokenForm(text: string): string {
    const stripped = tidy(stripAnnotations(text || ''));
    return stripped || (text || '').trim();
}

/**
 * Forces a learning-language side into a single speakable utterance. The
 * prompt already forbids all of this, but the prompt is a request and this is
 * the guarantee: nothing with a gloss, a slash alternative or a list marker in
 * it ever reaches the synthesiser, the card, or the speech evaluator.
 *
 * A slash is read as "alternatives, pick one" and only the first is kept. That
 * loses a genuine slash ("24/7"), which is rare inside a spoken utterance and
 * far less damaging than synthesising two unrelated phrases in a row.
 */
export function speakableUtterance(text: string): string {
    const source = (text || '').trim();
    if (!source) return '';

    const withoutAnnotations = stripAnnotations(source);
    const firstAlternative = withoutAnnotations.split(/[/|｜]/)[0];
    const withoutListMarker = firstAlternative
        .replace(/^\s*(?:[-*•]|\d+\s*[.)、])\s*/, '')
        .replace(/^["'“”„«『「]+/, '')
        .replace(/["'“”„»』」]+$/, '');

    return tidy(withoutListMarker) || tidy(withoutAnnotations) || source;
}

/**
 * Why the learning-language text cannot be spoken as written, or null when it
 * can. Used to give the generator one corrective retry before falling back to
 * speakableUtterance(), because a model that is told what it did wrong tends
 * to pick a sense, while sanitising silently keeps whichever sense happened to
 * come first.
 */
export function unspeakableReason(text: string): string | null {
    const source = (text || '').trim();
    if (!source) return 'it is empty';
    if (/[（(［[]/.test(source)) return 'it contains a parenthesized gloss or annotation';
    if (/[/|｜]/.test(source)) return 'it offers alternatives separated by a slash';
    if (/[;；]/.test(source)) return 'it joins separate phrases with a semicolon';
    if (/^\s*(?:[-*•]|\d+\s*[.)、])\s*/.test(source)) return 'it is written as a list item rather than an utterance';
    return null;
}

/**
 * Separates labels of different kinds on the known side. A comma reads as a
 * list, which makes two unrelated labels - which meaning, how polite - look
 * like exactly the list of senses this whole module exists to keep off a card:
 * "date (calendar day, casual)" invites being read as two meanings.
 */
const LABEL_SEPARATOR = ' \u00b7 ';

/**
 * Builds the known-language side: the utterance, plus the labels the learner
 * needs to read and nobody should say. Any annotation already on the base text
 * is dropped first, so recomposing a card (regenerating one side) cannot stack
 * "(calendar day) (calendar day)".
 */
export function composeKnownSide(text: string | undefined, tags: (string | null | undefined)[]): string {
    const base = spokenForm(text || '');
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const tag of tags) {
        const label = (tag || '').trim().replace(/^[（(]|[）)]$/g, '').trim();
        if (!label || seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        labels.push(label);
    }
    return labels.length > 0 ? `${base} (${labels.join(LABEL_SEPARATOR)})` : base;
}

export interface GeneratedCardFields {
    /** Absent on the regeneration path that rewrites only the learning side. */
    known_text?: string;
    learning_text: string;
    sense_tag: string;
    register: string;
    spoken_reading: string;
}

export interface AssembledCard {
    front_text: string;
    back_text: string;
    /** Reading of back_text in its own script (never romanised), '' unless the script hides the reading. */
    spoken_reading: string;
    /** Set when the model broke the speakable rule and the text had to be repaired. */
    repairedReason: string | null;
}

/**
 * Turns a model payload into the two card sides. The learning side is a bare
 * utterance; every label ends up on the known side, inside parentheses, where
 * spokenForm() keeps it away from the voice and from the speech evaluator.
 */
export function assembleCard(fields: GeneratedCardFields, learningLanguage: string): AssembledCard {
    const repairedReason = unspeakableReason(fields.learning_text);
    return {
        front_text: composeKnownSide(fields.known_text, [
            fields.sense_tag,
            registerTag(learningLanguage, fields.register),
        ]),
        back_text: speakableUtterance(fields.learning_text),
        spoken_reading: readingIsAmbiguous(learningLanguage) ? (fields.spoken_reading || '').trim() : '',
        repairedReason,
    };
}

/**
 * Normalizes text for a lenient transcription comparison: Unicode-normalized
 * (full-width/half-width, compatibility forms), lowercase, no punctuation,
 * no whitespace (transcribers segment CJK/Thai text inconsistently).
 *
 * For Korean it then goes one step further and compares PRONUNCIATION, not
 * spelling (see koreanPronunciation below): 역이 어디예요? and 여기 어디예요?
 * are spelled differently and sound identical, and the transcriber, which
 * cannot know which one was meant, writes the commoner spelling. Comparing
 * spellings failed every Korean clip of that card.
 *
 * KNOWN LIMIT, by construction: everywhere else this compares SPELLING, not
 * pronunciation. For a writing system where the spelling does not fix the
 * reading (see READING_OPAQUE_LANGUAGES) a wrong reading of the right
 * characters is transcribed back as the right characters and passes. That is
 * why audio for those languages is not accepted on transcript equality alone
 * - see generateCardAudio in cardGeneration.ts.
 */
export function normalizeForComparison(text: string, language = ''): string {
    const spelled = (text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/g, '');
    return normalizeLanguageCode(language).split('_')[0] === 'ko' ? koreanPronunciation(spelled) : spelled;
}

// ========================
// KOREAN PRONUNCIATION
// ========================
//
// Hangul is phonemic syllable by syllable, but not across syllables: the
// standard pronunciation rules (표준 발음법) change consonants at every
// syllable boundary, so different spellings can be the same sound. This
// rewrites Hangul into a spelling of how it is pronounced, by decomposing
// each syllable into jamo, applying the rules at each boundary, and
// recomposing. Two strings with the same output sound the same.
//
// COVERED (each with a test in plusaudio/test/cardText.test.js):
//   - 연음 (liaison): a final consonant moves onto a following silent ㅇ:
//     역이 -> 여기, 책을 -> 채글, 있어 -> 이써; a cluster moves its second
//     half: 읽어 -> 일거, 앉아 -> 안자, 없어 -> 업써.
//   - 구개음화 (palatalisation) on liaison before ㅣ: 같이 -> 가치, 굳이 -> 구지,
//     and before 히: 닫히다 -> 다치다.
//   - ㅎ rules: final ㅎ/ㄶ/ㅀ aspirates a following ㄱ ㄷ ㅂ ㅈ (좋다 -> 조타,
//     많고 -> 만코), tenses ㅅ (좋소 -> 조쏘), becomes ㄴ before ㄴ (놓는 -> 논는),
//     and drops before a vowel (좋아 -> 조아, 싫어 -> 시러); a final ㄱ ㄷ ㅂ ㅈ
//     before ㅎ aspirates it (축하 -> 추카, 입학 -> 이팍, 앉히다 -> 안치다).
//   - 음절의 끝소리 (final neutralisation) to ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅇ: 낮, 낫, 낟 all
//     -> 낟; ㄺ before ㄱ keeps ㄹ (맑게 -> 말께).
//   - 비음화 (nasalisation): 국물 -> 궁물, 합니다 -> 함니다, 받는 -> 반는, and ㄹ
//     after a non-ㄹ consonant -> ㄴ: 종로 -> 종노, 국력 -> 궁녁.
//   - 유음화 (lateralisation): 신라 -> 실라, 설날 -> 설랄.
//   - 경음화 (tensification) after an obstruent: 학교 -> 학꾜, 먹다 -> 먹따, and
//     after a stem-final ㄵ ㄻ ㄼ ㄾ: 앉다 -> 안따, 젊다 -> 점따.
//
// NOT COVERED, deliberately - each needs knowledge of word structure that
// spelling alone does not carry, and a wrong guess would make two different
// sounds compare equal:
//   - liaison across a real word boundary through the representative sound
//     (옷 안 [오단], 맛없다 [마덥따]): this always does plain liaison;
//   - ㄴ insertion (솜이불 [솜니불], 할 일 [할릴]);
//   - tensification that depends on morphology: after a ㄴ/ㅁ verb stem
//     (신고 [신꼬]), after the -(으)ㄹ adnominal (할 거예요 [할꺼예요]), and
//     사이시옷 compounds;
//   - ㅎ weakening between voiced sounds (은행 [으냉]), ㄹ->ㄴ exceptions
//     (의견란 [의견난]), ㄼ read as ㅂ (밟다 [밥따]);
//   - vowel variation (ㅢ as ㅣ/ㅔ, ㅖ as ㅔ, the ㅐ/ㅔ merger).
// A mismatch from any of these is not a failure: it just sends the clip on to
// the audio judge, which is what happened to every mismatch before.
//
// Whitespace has already been removed by normalizeForComparison, so the rules
// apply across word boundaries too. That is how connected speech sounds, and
// it is why the transcriber's own choice of spacing cannot matter.

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const INITIALS = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
/** The medial index of ㅣ. */
const VOWEL_I = 20;

const CLUSTERS: Record<string, [string, string]> = {
    'ㄳ': ['ㄱ', 'ㅅ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄶ': ['ㄴ', 'ㅎ'], 'ㄺ': ['ㄹ', 'ㄱ'], 'ㄻ': ['ㄹ', 'ㅁ'],
    'ㄼ': ['ㄹ', 'ㅂ'], 'ㄽ': ['ㄹ', 'ㅅ'], 'ㄾ': ['ㄹ', 'ㅌ'], 'ㄿ': ['ㄹ', 'ㅍ'], 'ㅀ': ['ㄹ', 'ㅎ'], 'ㅄ': ['ㅂ', 'ㅅ'],
};
/** 음절의 끝소리: every final as one of the seven sounds a coda can be. */
const NEUTRAL: Record<string, string> = {
    'ㄱ': 'ㄱ', 'ㄲ': 'ㄱ', 'ㅋ': 'ㄱ', 'ㄳ': 'ㄱ', 'ㄺ': 'ㄱ',
    'ㄴ': 'ㄴ', 'ㄵ': 'ㄴ', 'ㄶ': 'ㄴ',
    'ㄷ': 'ㄷ', 'ㅅ': 'ㄷ', 'ㅆ': 'ㄷ', 'ㅈ': 'ㄷ', 'ㅊ': 'ㄷ', 'ㅌ': 'ㄷ', 'ㅎ': 'ㄷ',
    'ㄹ': 'ㄹ', 'ㄼ': 'ㄹ', 'ㄽ': 'ㄹ', 'ㄾ': 'ㄹ', 'ㅀ': 'ㄹ',
    'ㅁ': 'ㅁ', 'ㄻ': 'ㅁ',
    'ㅂ': 'ㅂ', 'ㅍ': 'ㅂ', 'ㄿ': 'ㅂ', 'ㅄ': 'ㅂ',
    'ㅇ': 'ㅇ',
};
const ASPIRATED: Record<string, string> = { 'ㄱ': 'ㅋ', 'ㄷ': 'ㅌ', 'ㅂ': 'ㅍ', 'ㅈ': 'ㅊ' };
const TENSE: Record<string, string> = { 'ㄱ': 'ㄲ', 'ㄷ': 'ㄸ', 'ㅂ': 'ㅃ', 'ㅅ': 'ㅆ', 'ㅈ': 'ㅉ' };
const NASAL: Record<string, string> = { 'ㄱ': 'ㅇ', 'ㄷ': 'ㄴ', 'ㅂ': 'ㅁ' };
/** What is left of an ㅎ-final once the ㅎ itself is gone. */
const WITHOUT_H: Record<string, string> = { 'ㅎ': '', 'ㄶ': 'ㄴ', 'ㅀ': 'ㄹ' };
/** Stem-final clusters after which a lenis consonant is tensed (앉다 [안따]). */
const TENSING_STEM_CLUSTERS = new Set(['ㄵ', 'ㄻ', 'ㄼ', 'ㄾ']);

interface Syllable {
    initial: string;
    vowel: number;
    final: string;
}

/** The consonant a final ㄱ ㄷ ㅂ ㅈ class sound becomes with a following ㅎ. */
function aspirateWithH(consonant: string, nextVowel: number): string | null {
    if (['ㄱ', 'ㄲ', 'ㅋ'].includes(consonant)) return 'ㅋ';
    if (['ㅂ', 'ㅍ'].includes(consonant)) return 'ㅍ';
    if (['ㅈ', 'ㅊ'].includes(consonant)) return 'ㅊ';
    if (['ㄷ', 'ㅌ'].includes(consonant)) return nextVowel === VOWEL_I ? 'ㅊ' : 'ㅌ';
    if (['ㅅ', 'ㅆ'].includes(consonant)) return 'ㅌ';
    return null;
}

/** Applies the boundary rules between two adjacent syllables, in place. */
function applyBoundary(a: Syllable, b: Syllable): void {
    const original = a.final;
    let final = a.final;
    const initial = b.initial;
    if (!final) return;

    // ㅎ as (part of) the final.
    if (final in WITHOUT_H) {
        const rest = WITHOUT_H[final];
        if (initial in ASPIRATED) {
            b.initial = ASPIRATED[initial];
            a.final = rest;
            return;
        }
        if (initial === 'ㅅ') {
            b.initial = 'ㅆ';
            a.final = rest;
            return;
        }
        if (initial === 'ㄴ') {
            a.final = final === 'ㅎ' ? 'ㄴ' : rest;
            if (a.final === 'ㄹ') b.initial = 'ㄹ';
            return;
        }
        if (initial === 'ㅇ') {
            a.final = rest;
            final = rest;
            if (!final) return;
        }
    }

    // ㅎ as the next initial, after an obstruent.
    if (initial === 'ㅎ') {
        const cluster = CLUSTERS[final];
        let kept = '';
        let joined = final;
        if (cluster && !(cluster[0] in NASAL) && cluster[0] !== 'ㅅ') {
            [kept, joined] = cluster;
        } else if (cluster) {
            joined = NEUTRAL[final];
        }
        const aspirated = aspirateWithH(joined, b.vowel);
        if (aspirated) {
            a.final = kept;
            b.initial = aspirated;
        }
        return;
    }

    // 연음: the final moves onto a silent initial ㅇ.
    if (initial === 'ㅇ' && final !== 'ㅇ') {
        if ((final === 'ㄷ' || final === 'ㅌ') && b.vowel === VOWEL_I) {
            b.initial = final === 'ㄷ' ? 'ㅈ' : 'ㅊ';
            a.final = '';
            return;
        }
        if (final === 'ㄾ' && b.vowel === VOWEL_I) {
            a.final = 'ㄹ';
            b.initial = 'ㅊ';
            return;
        }
        const cluster = CLUSTERS[final];
        if (cluster) {
            a.final = cluster[0];
            b.initial = cluster[0] in NASAL && cluster[1] in TENSE ? TENSE[cluster[1]] : cluster[1];
            return;
        }
        b.initial = final;
        a.final = '';
        return;
    }

    // The coda is one of seven sounds before any further consonant.
    if (original === 'ㄺ' && initial === 'ㄱ') {
        a.final = 'ㄹ';
        b.initial = 'ㄲ';
        return;
    }
    final = NEUTRAL[final] ?? final;
    a.final = final;
    if (TENSING_STEM_CLUSTERS.has(original) && initial in TENSE) {
        b.initial = TENSE[initial];
        return;
    }

    if (initial === 'ㄹ') {
        if (final === 'ㅁ' || final === 'ㅇ') b.initial = 'ㄴ';
        else if (final in NASAL) {
            b.initial = 'ㄴ';
            a.final = NASAL[final];
        } else if (final === 'ㄴ') a.final = 'ㄹ';
        return;
    }
    if (initial === 'ㄴ') {
        if (final === 'ㄹ') b.initial = 'ㄹ';
        else if (final in NASAL) a.final = NASAL[final];
        return;
    }
    if (initial === 'ㅁ') {
        if (final in NASAL) a.final = NASAL[final];
        return;
    }
    if (final in NASAL && initial in TENSE) b.initial = TENSE[initial];
}

function decompose(char: string): Syllable | null {
    const code = char.codePointAt(0)!;
    if (code < HANGUL_BASE || code > HANGUL_LAST) return null;
    const index = code - HANGUL_BASE;
    return {
        initial: INITIALS[Math.floor(index / 588)],
        vowel: Math.floor((index % 588) / 28),
        final: FINALS[index % 28],
    };
}

function compose({ initial, vowel, final }: Syllable): string {
    return String.fromCodePoint(HANGUL_BASE + (INITIALS.indexOf(initial) * 21 + vowel) * 28 + FINALS.indexOf(final));
}

/**
 * Hangul rewritten as it is pronounced under the rules listed above, with
 * anything that is not a Hangul syllable left as it is (and acting as a
 * boundary no rule crosses). Exported for its tests; callers compare through
 * normalizeForComparison.
 */
export function koreanPronunciation(text: string): string {
    const units: Array<Syllable | string> = [...(text || '')].map((char) => decompose(char) ?? char);
    for (let i = 0; i < units.length; i++) {
        const current = units[i];
        if (typeof current === 'string') continue;
        const next = units[i + 1];
        if (next !== undefined && typeof next !== 'string') applyBoundary(current, next);
        else current.final = NEUTRAL[current.final] ?? current.final;
    }
    return units.map((unit) => (typeof unit === 'string' ? unit : compose(unit))).join('');
}
