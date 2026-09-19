// Prompts for card generation and regeneration.
//
// These live next to the text policy they enforce (cardText.ts) and away from
// the edge function's plumbing, so the wording can be read, diffed and unit
// tested on its own (src/__tests__/edge/cardPrompts.test.js).
//
// The through-line: an amgi card is not a dictionary entry, it is something a
// person says. Every rule below exists because a real generation broke it -
// "date" came back as `날짜 (달력상의 날짜), 데이트 (연애 약속)`, which the
// synthesiser read aloud as two unrelated words, and "Are you hungry?" came
// back as `배고파요?` with the politeness level chosen by nobody.

import {
    languageName,
    readingIsAmbiguous,
    registerGuidance,
    romanizationSystem,
    varietyGuidance,
} from "./cardText.ts";

export const CARD_GENERATION_SYSTEM_PROMPT = `You write flashcards for an app in which every card is heard and spoken, never only read. Both sides are sent to a speech synthesiser exactly as you write them, and the learner repeats the learning-language side out loud.

So a card side is one natural utterance that a person could actually say - not a dictionary entry, not a list of senses, not a headword with a gloss attached. A side that cannot be said out loud is a broken card even when every word in it is correct.`;

export const CARD_REGENERATION_SYSTEM_PROMPT = `You rewrite flashcards for an app in which every card is heard and spoken, never only read. Both sides are sent to a speech synthesiser exactly as you write them, and the learner repeats the learning-language side out loud.

The learner rejected the current wording, so change it: produce a different, better utterance rather than a paraphrase of the same one. A card side is one natural utterance that a person could actually say - not a dictionary entry, not a list of senses, not a headword with a gloss attached.`;

interface CardLanguages {
    knownLanguage: string;
    learningLanguage: string;
}

/**
 * The rules that make a card speakable. Shared by generation and every
 * regeneration path, because a regenerated side is just as spoken as a
 * generated one and the old regeneration prompts ("I was not satisfied with
 * the previous translation") carried none of this.
 */
function speakingRules({ knownLanguage, learningLanguage }: CardLanguages): string {
    const known = languageName(knownLanguage);
    const learning = languageName(learningLanguage);
    const variety = varietyGuidance(learningLanguage);
    const romanization = romanizationSystem(learningLanguage);

    const rules = [
        `SPEAKABLE TEXT ONLY. known_text and learning_text are synthesised verbatim. They contain the words to be said and nothing else: no parentheses or brackets, no slashes, no "or", no second translation, no romanisation, no part-of-speech or gender labels, no quotation marks, no numbering, no commentary. Sentence punctuation (? ! . ,) is fine.`,

        `EXACTLY ONE SENSE. If the input can mean more than one thing, pick the single meaning a learner is most likely to have meant in everyday speech and write the card for that meaning alone. Never put two meanings on one card: a side that reads "calendar day, romantic outing" is not something anyone says.`,

        `SENSE_TAG IS EMPTY UNLESS IT TELLS TWO CARDS APART. It is a disambiguator, not a description, and it is printed on the card, so a tag that adds nothing is text the learner reads past on every repetition. Before writing one, name the OTHER card: the different, equally everyday meaning of the same input that someone could have meant instead. If you cannot name that other card, sense_tag is empty. The English word "date" has one ("calendar day" against "romantic outing"). "Are you hungry?" has none, so its sense_tag is empty - "hungry now" and "feeling hungry" are the same meaning said again. A sentence almost never needs a tag; a bare word sometimes does. Never restate or paraphrase the card, never name its topic, its situation or its tone, and never repeat what the register field already reports. When a tag is genuinely needed, write the meaning in ${known}, two or three words, no parentheses, spelled and capitalised the way ${known} spells those words in running text.`,

        `KEEP THE SHAPE OF THE INPUT. A single word becomes a single word in its citation form, a phrase becomes a phrase, a sentence becomes a sentence. Do not pad a word into a full sentence and do not reduce a sentence to a word.`,

        `REGISTER. ${registerGuidance(learningLanguage)} Report in the register field which level learning_text actually came out at: "casual", "polite" or "formal". When the input is already written in ${learning}, keep the level the learner wrote and report that.`,
    ];

    if (variety) {
        rules.push(`VARIETY. Write ${variety}`);
    }

    if (readingIsAmbiguous(learningLanguage) && romanization) {
        rules.push(`READING. ${learning} spelling does not determine pronunciation, and the audio is checked against the text, so a wrong reading of the right characters would go unnoticed. Fill spoken_reading with ${romanization}: exactly how learning_text must be read aloud, in the Latin alphabet, nothing else.`);
    } else {
        rules.push(`READING. Leave spoken_reading empty: ${learning} spelling already determines the pronunciation.`);
    }

    return rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n\n');
}

export function buildCardGenerationPrompt({
    userInput,
    knownLanguage,
    learningLanguage,
}: CardLanguages & { userInput: string }): string {
    const known = languageName(knownLanguage);
    const learning = languageName(learningLanguage);

    return `The learner speaks ${known} and is learning ${learning}.

Their input: "${userInput}"

Write one flashcard: known_text in ${known}, learning_text in ${learning}.

DIRECTION. If the input is written in ${known}, known_text is that input, corrected only for obvious typos, and learning_text is its translation. If the input is written in ${learning}, learning_text is that input, corrected only for obvious typos, and known_text is its translation. If the input is in any other language, translate it into both.

${speakingRules({ knownLanguage, learningLanguage })}`;
}

export function buildKnownSideRegenerationPrompt({
    knownLanguage,
    learningLanguage,
    learningText,
    rejectedKnownText,
}: CardLanguages & { learningText: string; rejectedKnownText: string }): string {
    const known = languageName(knownLanguage);
    const learning = languageName(learningLanguage);

    return `A flashcard says this in ${learning}, and it stays exactly as it is: "${learningText}"

The learner rejected this ${known} side of it: "${rejectedKnownText}"

Write a better known_text: what a ${known} speaker would actually say to mean that ${learning} utterance, matching its register and its level of formality. Report in register which level the ${learning} utterance above uses. Leave sense_tag empty unless the utterance really has a second everyday meaning a separate card would teach.

${speakingRules({ knownLanguage, learningLanguage })}`;
}

export function buildLearningSideRegenerationPrompt({
    knownLanguage,
    learningLanguage,
    knownText,
    rejectedLearningText,
    userInput,
}: CardLanguages & { knownText: string; rejectedLearningText: string; userInput: string }): string {
    const known = languageName(knownLanguage);
    const learning = languageName(learningLanguage);
    const origin = userInput?.trim() ? `\n\nThe learner originally typed: "${userInput}"` : '';

    return `A flashcard says this in ${known}: "${knownText}"

Anything in parentheses there is a label for the learner's eyes - which meaning the card teaches, and which politeness level - and is not part of the utterance. Do not translate it.

The learner rejected this ${learning} side: "${rejectedLearningText}"${origin}

Write a better learning_text: what a native ${learning} speaker would actually say in that situation. The ${known} side keeps its wording; only its labels are rewritten from the register and sense_tag you report.

${speakingRules({ knownLanguage, learningLanguage })}`;
}

export function buildBothSidesRegenerationPrompt({
    knownLanguage,
    learningLanguage,
    knownText,
    learningText,
    userInput,
}: CardLanguages & { knownText: string; learningText: string; userInput: string }): string {
    const known = languageName(knownLanguage);
    const learning = languageName(learningLanguage);
    const origin = userInput?.trim() ? `The learner originally typed: "${userInput}"` : `The learner gave no original input.`;

    return `The learner rejected both sides of this flashcard:
- ${known}: "${knownText}"
- ${learning}: "${learningText}"

${origin}

Write the card again from the original meaning: known_text in ${known}, learning_text in ${learning}. Do not merely reword the rejected version - if it was vague, or picked an unlikely meaning, or sounded like a textbook rather than speech, fix that.

${speakingRules({ knownLanguage, learningLanguage })}`;
}

/**
 * The corrective retry. A model that is told which rule it broke usually picks
 * a sense; sanitising its answer in code keeps whichever sense happened to
 * come first, so it is the fallback, not the first response.
 */
export function buildUnspeakableRetryPrompt(previousPrompt: string, rejectedText: string, reason: string): string {
    return `${previousPrompt}

YOUR PREVIOUS ANSWER WAS REJECTED. You returned learning_text as "${rejectedText}", but ${reason}. That text goes straight to a speech synthesiser, so it has to be one thing a person says. Choose the single most likely everyday meaning and write only that utterance in learning_text. Put the meaning you chose in sense_tag only if the input really does have a second, equally everyday meaning that a different card would teach; otherwise leave sense_tag empty.`;
}
