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
    const pattern = NATIVE_SCRIPT_PATTERNS[normalizeLanguageCode(language)];
    if (!pattern) return false;
    const trimmed = (text || '').trim();
    if (!trimmed) return false;
    if (pattern.test(trimmed)) return false;
    return /[a-zA-Z]/.test(trimmed);
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
