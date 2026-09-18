/**
 * The text policy behind every generated card: one sense, one register, and
 * nothing in the spoken text that is not meant to be said.
 *
 * This is edge-function code (Deno) required straight from jest, the same way
 * cardAudioDeletion.test.js requires cardDeletion.ts - the module is pure on
 * purpose so it can be tested where the rest of the suite lives.
 */
const {
  assembleCard,
  composeKnownSide,
  defaultRegisterLevel,
  languageName,
  marksRegister,
  normalizeForComparison,
  normalizeLanguageCode,
  readingIsAmbiguous,
  registerTag,
  speakableUtterance,
  spokenForm,
  transcriptionLanguage,
  unspeakableReason,
} = require('../../../supabase/functions/_shared/cardText.ts');

describe('spokenForm', () => {
  test('drops the labels a card shows but nobody says', () => {
    expect(spokenForm('Goodbye (to someone leaving)')).toBe('Goodbye');
    expect(spokenForm('行く [いく]')).toBe('行く');
    expect(spokenForm('배고파요?')).toBe('배고파요?');
  });

  test('closes the gap a stripped label leaves in front of punctuation', () => {
    expect(spokenForm('date (calendar day), please')).toBe('date, please');
  });

  test('keeps text that is nothing but a label rather than saying nothing', () => {
    expect(spokenForm('(mmm)')).toBe('(mmm)');
  });

  test('leaves punctuation that belongs to the sentence, including Spanish openers', () => {
    expect(spokenForm('¿Tienes hambre?')).toBe('¿Tienes hambre?');
    expect(speakableUtterance('¡Claro!')).toBe('¡Claro!');
  });
});

describe('speakableUtterance', () => {
  // The live failure this whole change exists for: the input "date" came back
  // as two senses with Korean glosses, and the synthesiser read out
  // "날짜 , 데이트" - two unrelated words the learner cannot repeat.
  test('repairs the concatenated-senses card into something sayable', () => {
    const repaired = speakableUtterance('날짜 (달력상의 날짜), 데이트 (연애 약속)');
    expect(repaired).toBe('날짜, 데이트');
    expect(repaired).not.toMatch(/[()]/);
  });

  test('keeps the first of slash-separated alternatives', () => {
    expect(speakableUtterance('안녕하세요 / 안녕')).toBe('안녕하세요');
    expect(speakableUtterance('날짜/데이트')).toBe('날짜');
  });

  test('strips list markers and quoting', () => {
    expect(speakableUtterance('1. 배고파요?')).toBe('배고파요?');
    expect(speakableUtterance('- 배고파요?')).toBe('배고파요?');
    expect(speakableUtterance('"배고파요?"')).toBe('배고파요?');
  });

  test('leaves a normal utterance alone, commas and all', () => {
    expect(speakableUtterance('집에 가는 길에 그거 가져올게.')).toBe('집에 가는 길에 그거 가져올게.');
    expect(speakableUtterance('Yes, please')).toBe('Yes, please');
  });

  test('never returns nothing to say', () => {
    expect(speakableUtterance('(hmm)')).toBe('(hmm)');
    expect(speakableUtterance('   ')).toBe('');
  });
});

describe('unspeakableReason', () => {
  test('names what makes text unsayable', () => {
    expect(unspeakableReason('날짜 (달력상의 날짜), 데이트')).toMatch(/gloss|annotation/);
    expect(unspeakableReason('안녕하세요 / 안녕')).toMatch(/slash/);
    expect(unspeakableReason('안녕하세요; 안녕')).toMatch(/semicolon/);
    expect(unspeakableReason('1. 배고파요?')).toMatch(/list/);
    expect(unspeakableReason('   ')).toMatch(/empty/);
  });

  test('passes an ordinary utterance', () => {
    expect(unspeakableReason('배고파요?')).toBeNull();
    expect(unspeakableReason("I'll pick it up on the way home")).toBeNull();
  });
});

describe('composeKnownSide', () => {
  test('puts the labels where only the eye sees them', () => {
    expect(composeKnownSide('date', ['calendar day'])).toBe('date (calendar day)');
    expect(composeKnownSide("It's okay.", ['casual'])).toBe("It's okay. (casual)");
    expect(composeKnownSide('date', ['calendar day', 'casual'])).toBe('date (calendar day, casual)');
  });

  test('leaves an unambiguous card unlabelled', () => {
    expect(composeKnownSide('Are you hungry?', ['', null, undefined])).toBe('Are you hungry?');
  });

  test('does not stack labels when a card is recomposed', () => {
    const once = composeKnownSide('date', ['calendar day']);
    expect(composeKnownSide(once, ['calendar day'])).toBe('date (calendar day)');
  });

  test('never speaks its own labels', () => {
    expect(spokenForm(composeKnownSide('date', ['calendar day']))).toBe('date');
  });
});

describe('register policy', () => {
  test('Korean and Japanese default to the level usable with a stranger', () => {
    expect(defaultRegisterLevel('ko')).toBe('polite');
    expect(defaultRegisterLevel('ja')).toBe('polite');
    expect(marksRegister('ko')).toBe(true);
  });

  test('a language that does not mark register gets no label', () => {
    expect(defaultRegisterLevel('en')).toBeNull();
    expect(registerTag('en', 'casual')).toBeNull();
  });

  test('only a departure from the default is worth labelling', () => {
    expect(registerTag('ko', 'polite')).toBeNull();
    expect(registerTag('ko', 'casual')).toBe('casual');
    expect(registerTag('ja', 'formal')).toBe('formal');
    expect(registerTag('ko', 'nonsense')).toBeNull();
    expect(registerTag('ko', '')).toBeNull();
  });
});

describe('assembleCard', () => {
  test('the polite default card carries no clutter', () => {
    const card = assembleCard({
      known_text: 'Are you hungry?',
      learning_text: '배고파요?',
      sense_tag: '',
      register: 'polite',
      spoken_reading: '',
    }, 'ko');

    expect(card).toMatchObject({
      front_text: 'Are you hungry?',
      back_text: '배고파요?',
      spoken_reading: '',
      repairedReason: null,
    });
  });

  test('a casual card says so on the side nobody speaks', () => {
    const card = assembleCard({
      known_text: "It's okay.",
      learning_text: '괜찮아',
      sense_tag: '',
      register: 'casual',
      spoken_reading: '',
    }, 'ko');

    expect(card.front_text).toBe("It's okay. (casual)");
    expect(card.back_text).toBe('괜찮아');
    expect(spokenForm(card.front_text)).toBe("It's okay.");
  });

  test('an ambiguous input becomes one sense with a label', () => {
    const card = assembleCard({
      known_text: 'date',
      learning_text: '날짜',
      sense_tag: 'calendar day',
      register: 'polite',
      spoken_reading: '',
    }, 'ko');

    expect(card.front_text).toBe('date (calendar day)');
    expect(card.back_text).toBe('날짜');
  });

  test('a model that ignores the rule still cannot reach the synthesiser', () => {
    const card = assembleCard({
      known_text: 'date',
      learning_text: '날짜 (달력상의 날짜), 데이트 (연애 약속)',
      sense_tag: 'calendar day',
      register: 'polite',
      spoken_reading: '',
    }, 'ko');

    expect(card.back_text).not.toMatch(/[()]/);
    expect(card.repairedReason).toMatch(/gloss|annotation/);
  });

  test('keeps a reading where the script hides one and drops it where it does not', () => {
    const japanese = assembleCard({
      known_text: 'went',
      learning_text: '行きました',
      sense_tag: '',
      register: 'polite',
      spoken_reading: 'ikimashita',
    }, 'ja');
    expect(japanese.spoken_reading).toBe('ikimashita');

    const korean = assembleCard({
      known_text: 'went',
      learning_text: '갔어요',
      sense_tag: '',
      register: 'polite',
      spoken_reading: 'gasseoyo',
    }, 'ko');
    expect(korean.spoken_reading).toBe('');
  });
});

describe('language codes', () => {
  test('readings are only ambiguous where the script allows it', () => {
    expect(readingIsAmbiguous('ja')).toBe(true);
    expect(readingIsAmbiguous('zh_cn')).toBe(true);
    expect(readingIsAmbiguous('zh-HK')).toBe(true);
    expect(readingIsAmbiguous('ko')).toBe(false);
    expect(readingIsAmbiguous('en')).toBe(false);
  });

  test('Cantonese keeps its own transcription language', () => {
    expect(transcriptionLanguage('zh_hk')).toBe('yue');
    expect(transcriptionLanguage('zh_cn')).toBe('zh');
    expect(transcriptionLanguage('ko')).toBe('ko');
  });

  test('codes normalise and name themselves', () => {
    expect(normalizeLanguageCode('zh-HK')).toBe('zh_hk');
    expect(languageName('zh_hk')).toBe('Cantonese');
    expect(languageName('ko')).toBe('Korean');
    expect(languageName('xx')).toBe('xx');
  });
});

describe('normalizeForComparison', () => {
  test('forgives the differences a transcriber invents', () => {
    expect(normalizeForComparison('배고파요?')).toBe(normalizeForComparison('배고파요'));
    expect(normalizeForComparison('집에 가는 길에')).toBe(normalizeForComparison('집에가는길에'));
    expect(normalizeForComparison('Hello, there!')).toBe(normalizeForComparison('hello there'));
  });

  test('and cannot see pronunciation at all, which is why readings exist', () => {
    // 行った is "itta" or "okonatta"; both transcribe to these same characters.
    expect(normalizeForComparison('行った')).toBe(normalizeForComparison('行った'));
    expect(readingIsAmbiguous('ja')).toBe(true);
  });
});
