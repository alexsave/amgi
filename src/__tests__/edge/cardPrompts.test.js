/**
 * The generation prompts. A prompt cannot be unit tested for the quality of
 * what it produces, but it can be pinned on the decisions it is supposed to
 * make explicit: which politeness level, which sense, which variety, and the
 * standing rule that a card side is something a person says.
 */
const {
  CARD_GENERATION_SYSTEM_PROMPT,
  CARD_REGENERATION_SYSTEM_PROMPT,
  buildBothSidesRegenerationPrompt,
  buildCardGenerationPrompt,
  buildKnownSideRegenerationPrompt,
  buildLearningSideRegenerationPrompt,
  buildUnspeakableRetryPrompt,
} = require('../../../supabase/functions/_shared/cardPrompts.ts');

const { LANGUAGE_NAMES } = require('../../../supabase/functions/_shared/cardText.ts');

const generation = (learningLanguage, userInput = 'Are you hungry?') =>
  buildCardGenerationPrompt({ userInput, knownLanguage: 'en', learningLanguage });

describe('card generation prompt', () => {
  test('states the direction in language names, not codes', () => {
    const prompt = generation('ko');
    expect(prompt).toContain('The learner speaks English and is learning Korean.');
    expect(prompt).toContain('"Are you hungry?"');
    expect(prompt).toContain('known_text is that input');
  });

  test('demands one speakable utterance', () => {
    const prompt = generation('ko');
    expect(prompt).toContain('SPEAKABLE TEXT ONLY.');
    expect(prompt).toContain('synthesised verbatim');
    expect(prompt).toContain('no parentheses or brackets');
    expect(prompt).toContain('EXACTLY ONE SENSE.');
    expect(prompt).toContain('sense_tag');
  });

  test('tells the model that a sense tag is the exception, not the routine', () => {
    // Live generations came back as "Are you hungry? (hungry now)" and
    // "(feeling hungry)": restatements, on inputs with nothing to disambiguate.
    const prompt = generation('ko');
    expect(prompt).toContain('SENSE_TAG IS EMPTY UNLESS IT TELLS TWO CARDS APART.');
    expect(prompt).toContain('name the OTHER card');
    expect(prompt).toContain('"Are you hungry?" has none');
    expect(prompt).toMatch(/[Nn]ever restate or paraphrase the card/);
    // The old rule asked for lower case, which is how "I am okay" became
    // "i am okay" on a card.
    expect(prompt).not.toContain('lower case');
    expect(prompt).toContain('capitalised the way English spells those words in running text');
  });

  test('the corrective retry does not force a tag onto a single-sense input', () => {
    const retry = buildUnspeakableRetryPrompt('previous prompt', '날짜, 데이트', 'it lists two senses');
    expect(retry).toContain('otherwise leave sense_tag empty');
  });

  test('the system prompt says what a card is for', () => {
    expect(CARD_GENERATION_SYSTEM_PROMPT).toMatch(/heard and spoken/);
    expect(CARD_REGENERATION_SYSTEM_PROMPT).toMatch(/heard and spoken/);
    expect(CARD_REGENERATION_SYSTEM_PROMPT).toMatch(/rejected/);
  });
});

describe('register is chosen, not left to chance', () => {
  test('Korean gets 해요체 by name', () => {
    const prompt = generation('ko');
    expect(prompt).toContain('해요체');
    expect(prompt).toContain('반말');
    expect(prompt).toMatch(/REGISTER\./);
  });

  test('Japanese gets です／ます by name', () => {
    expect(generation('ja')).toContain('です／ます');
  });

  test('a T-V language gets its polite second person', () => {
    expect(generation('es')).toContain('usted');
    expect(generation('fr')).toContain('vous');
    expect(generation('de')).toContain('Sie');
    expect(generation('ru')).toContain('вы');
  });

  test('every supported learning language says something about register', () => {
    for (const code of Object.keys(LANGUAGE_NAMES)) {
      expect(generation(code)).toMatch(/REGISTER\. \S/);
    }
  });
});

describe('variety agrees with the voice', () => {
  test('the hard-coded TTS dialects are stated in the text prompt too', () => {
    expect(generation('es')).toContain('European Spanish');
    expect(generation('pt')).toContain('European Portuguese');
    expect(generation('ar')).toContain('Modern Standard Arabic');
    expect(generation('zh_hk')).toContain('Cantonese');
  });
});

describe('readings', () => {
  test('are asked for where the spelling hides them', () => {
    const japanese = generation('ja', '行った');
    expect(japanese).toContain('Hepburn romaji');
    expect(japanese).toContain('spoken_reading');
    expect(japanese).toMatch(/does not determine pronunciation/);
  });

  test('are not asked for where the spelling determines them', () => {
    expect(generation('ko')).toContain('Leave spoken_reading empty');
    expect(generation('es')).toContain('Leave spoken_reading empty');
  });
});

describe('regeneration carries the same policy', () => {
  const languages = { knownLanguage: 'en', learningLanguage: 'ko' };

  test('rewriting the known side pins the learning side', () => {
    const prompt = buildKnownSideRegenerationPrompt({
      ...languages,
      learningText: '배고파요?',
      rejectedKnownText: 'Are you hungry?',
    });
    expect(prompt).toContain('배고파요?');
    expect(prompt).toContain('it stays exactly as it is');
    expect(prompt).toContain('해요체');
  });

  test('rewriting the learning side keeps the labels out of the translation', () => {
    const prompt = buildLearningSideRegenerationPrompt({
      ...languages,
      knownText: 'date (calendar day)',
      rejectedLearningText: '날짜',
      userInput: 'date',
    });
    expect(prompt).toContain('date (calendar day)');
    expect(prompt).toContain('Do not translate it.');
    expect(prompt).toContain('The learner originally typed: "date"');
    expect(prompt).toContain('EXACTLY ONE SENSE.');
  });

  test('rewriting both sides goes back to the original meaning', () => {
    const prompt = buildBothSidesRegenerationPrompt({
      ...languages,
      knownText: 'date',
      learningText: '날짜',
      userInput: 'date',
    });
    expect(prompt).toContain('rejected both sides');
    expect(prompt).toContain('Do not merely reword');
    expect(prompt).toContain('해요체');
  });

  test('a missing original input does not leave a dangling sentence', () => {
    const prompt = buildBothSidesRegenerationPrompt({
      ...languages,
      knownText: 'date',
      learningText: '날짜',
      userInput: '',
    });
    expect(prompt).toContain('The learner gave no original input.');
    expect(prompt).not.toContain('originally typed: ""');
  });

  test('the corrective retry says which rule was broken', () => {
    const base = generation('ko', 'date');
    const retry = buildUnspeakableRetryPrompt(base, '날짜 (달력상의 날짜), 데이트', 'it contains a parenthesized gloss or annotation');
    expect(retry).toContain(base);
    expect(retry).toContain('YOUR PREVIOUS ANSWER WAS REJECTED.');
    expect(retry).toContain('it contains a parenthesized gloss or annotation');
    expect(retry).toContain('날짜 (달력상의 날짜), 데이트');
  });
});

describe('prompt hygiene', () => {
  const everyPrompt = () => {
    const prompts = [CARD_GENERATION_SYSTEM_PROMPT, CARD_REGENERATION_SYSTEM_PROMPT];
    for (const code of Object.keys(LANGUAGE_NAMES)) {
      prompts.push(generation(code));
      prompts.push(buildKnownSideRegenerationPrompt({
        knownLanguage: 'en',
        learningLanguage: code,
        learningText: 'x',
        rejectedKnownText: 'y',
      }));
      prompts.push(buildLearningSideRegenerationPrompt({
        knownLanguage: 'en',
        learningLanguage: code,
        knownText: 'x',
        rejectedLearningText: 'y',
        userInput: 'z',
      }));
      prompts.push(buildBothSidesRegenerationPrompt({
        knownLanguage: 'en',
        learningLanguage: code,
        knownText: 'x',
        learningText: 'y',
        userInput: 'z',
      }));
    }
    return prompts;
  };

  test('no template placeholder ever reaches the model', () => {
    for (const prompt of everyPrompt()) {
      expect(prompt).not.toMatch(/\{[a-z_]+\}/);
      expect(prompt).not.toContain('undefined');
    }
  });

  test('no em dashes', () => {
    for (const prompt of everyPrompt()) {
      expect(prompt).not.toContain('—');
    }
  });
});
