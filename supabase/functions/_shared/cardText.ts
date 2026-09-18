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
// Imported by the `cards` and `speech` edge functions (Deno) and unit tested
// from jest (src/__tests__/edge/cardText.test.js), so it must stay free of
// Deno APIs and of npm:/jsr: imports.

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

const ROMANIZATION_SYSTEMS: Record<string, string> = {
    ja: 'Hepburn romaji (for example 行った read as one word: "itta")',
    zh_cn: 'Hanyu Pinyin with tone numbers (for example "xing2 le")',
    zh_hk: 'Jyutping with tone numbers (for example "hang4 zo2")',
};

export function romanizationSystem(language: string): string | null {
    return ROMANIZATION_SYSTEMS[normalizeLanguageCode(language)] ?? null;
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
    return labels.length > 0 ? `${base} (${labels.join(', ')})` : base;
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
    /** Romanisation of back_text, '' unless the script hides the reading. */
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
 * KNOWN LIMIT, by construction: this compares SPELLING, not pronunciation. For
 * a writing system where the spelling does not fix the reading (see
 * READING_OPAQUE_LANGUAGES) a wrong reading of the right characters is
 * transcribed back as the right characters and passes. That is why audio for
 * those languages is not accepted on transcript equality alone - see
 * validateAndGenerateAudio in cards/index.ts.
 */
export function normalizeForComparison(text: string): string {
    return (text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/g, '');
}
