import {
  DECK_EXPORT_FORMAT,
  DECK_EXPORT_VERSION,
  buildDeckExportPayload,
  parseDeckImportPayload,
  uniqueImportDeckName
} from '../../utils/deckExport';

const deck = {
  id: 'deck-uuid',
  name: 'Korean Phrases',
  known_language: 'en',
  learning_language: 'ko'
};

const cards = [
  {
    id: 'card-1',
    front_text: 'Hello',
    back_text: '안녕하세요',
    front_lang: 'en',
    back_lang: 'ko',
    front_audio_path: 'abc123_front.wav',
    back_audio_path: 'abc123_back.wav',
    review: { card_state: 'review', repetitions: 4 }
  },
  {
    id: 'card-2',
    front_text: 'Thank you',
    back_text: '감사합니다',
    front_lang: 'en',
    back_lang: 'ko',
    front_audio_path: null,
    back_audio_path: null,
    review: { card_state: 'new' }
  }
];

describe('buildDeckExportPayload', () => {
  test('carries every card passed in, not just a subset', () => {
    const bigCardList = Array.from({ length: 300 }, (_, i) => ({
      front_text: `front ${i}`,
      back_text: `back ${i}`,
      front_lang: 'en',
      back_lang: 'ko'
    }));

    const payload = buildDeckExportPayload(deck, bigCardList);
    expect(payload.cards).toHaveLength(300);
  });

  test('includes format/version markers and deck metadata', () => {
    const payload = buildDeckExportPayload(deck, cards);
    expect(payload.format).toBe(DECK_EXPORT_FORMAT);
    expect(payload.version).toBe(DECK_EXPORT_VERSION);
    expect(payload.deck).toEqual({
      name: 'Korean Phrases',
      known_language: 'en',
      learning_language: 'ko'
    });
  });

  test('drops ids and review/scheduling state, keeps text/lang/audio', () => {
    const payload = buildDeckExportPayload(deck, cards);
    expect(payload.cards).toEqual([
      {
        front_text: 'Hello',
        back_text: '안녕하세요',
        front_lang: 'en',
        back_lang: 'ko',
        front_audio_path: 'abc123_front.wav',
        back_audio_path: 'abc123_back.wav'
      },
      {
        front_text: 'Thank you',
        back_text: '감사합니다',
        front_lang: 'en',
        back_lang: 'ko',
        front_audio_path: null,
        back_audio_path: null
      }
    ]);
    payload.cards.forEach(card => {
      expect(card.id).toBeUndefined();
      expect(card.review).toBeUndefined();
    });
  });

  test('refuses to export a deck with no name or no learning language', () => {
    expect(() => buildDeckExportPayload({ ...deck, name: '' }, cards)).toThrow(/name/);
    expect(() => buildDeckExportPayload({ ...deck, learning_language: undefined }, cards)).toThrow(/language/);
  });

  test('handles an empty deck', () => {
    const payload = buildDeckExportPayload(deck, []);
    expect(payload.cards).toEqual([]);
  });
});

describe('parseDeckImportPayload', () => {
  test('round-trips a payload built by buildDeckExportPayload', () => {
    const payload = buildDeckExportPayload(deck, cards);
    const parsed = parseDeckImportPayload(payload);

    expect(parsed.deck).toEqual({
      name: 'Korean Phrases',
      known_language: 'en',
      learning_language: 'ko'
    });
    expect(parsed.cards).toEqual([
      { front_text: 'Hello', back_text: '안녕하세요', front_lang: 'en', back_lang: 'ko' },
      { front_text: 'Thank you', back_text: '감사합니다', front_lang: 'en', back_lang: 'ko' }
    ]);
  });

  test('never carries audio paths through, even though they are present in the file', () => {
    const payload = buildDeckExportPayload(deck, cards);
    const parsed = parseDeckImportPayload(payload);
    parsed.cards.forEach(card => {
      expect(card.front_audio_path).toBeUndefined();
      expect(card.back_audio_path).toBeUndefined();
    });
  });

  test('rejects a file that is not an amgi deck export', () => {
    expect(() => parseDeckImportPayload(null)).toThrow(/not an amgi deck export/);
    expect(() => parseDeckImportPayload({})).toThrow(/not an amgi deck export/);
    expect(() => parseDeckImportPayload({ format: 'something-else' })).toThrow(/not an amgi deck export/);
  });

  test('rejects the old lossy shape (a raw deck object with no format marker)', () => {
    const oldShape = { id: '123', name: 'Old Deck', cards: [{ front_text: 'a', back_text: 'b' }] };
    expect(() => parseDeckImportPayload(oldShape)).toThrow(/not an amgi deck export/);
  });

  test('rejects an unsupported future version', () => {
    const payload = buildDeckExportPayload(deck, cards);
    expect(() => parseDeckImportPayload({ ...payload, version: 99 })).toThrow(/newer version/);
  });

  test('rejects a payload missing a deck name or learning language', () => {
    const payload = buildDeckExportPayload(deck, cards);
    expect(() => parseDeckImportPayload({ ...payload, deck: { ...payload.deck, name: '' } })).toThrow(/deck name/);
    expect(() => parseDeckImportPayload({ ...payload, deck: { ...payload.deck, learning_language: undefined } })).toThrow(/learning language/);
  });

  test('rejects a card missing its text', () => {
    const payload = buildDeckExportPayload(deck, cards);
    payload.cards[0] = { ...payload.cards[0], front_text: undefined };
    expect(() => parseDeckImportPayload(payload)).toThrow(/Card 1/);
  });

  test('defaults missing per-card language codes from the deck', () => {
    const payload = buildDeckExportPayload(deck, cards);
    payload.cards[0].front_lang = undefined;
    payload.cards[0].back_lang = undefined;
    const parsed = parseDeckImportPayload(payload);
    expect(parsed.cards[0].front_lang).toBe('en');
    expect(parsed.cards[0].back_lang).toBe('ko');
  });

  test('defaults a missing known_language to en', () => {
    const payload = buildDeckExportPayload(deck, cards);
    delete payload.deck.known_language;
    const parsed = parseDeckImportPayload(payload);
    expect(parsed.deck.known_language).toBe('en');
  });

  test('tolerates a deck with zero cards', () => {
    const payload = buildDeckExportPayload(deck, []);
    const parsed = parseDeckImportPayload(payload);
    expect(parsed.cards).toEqual([]);
  });
});

describe('uniqueImportDeckName', () => {
  test('keeps the original name when nothing collides', () => {
    expect(uniqueImportDeckName('Korean Phrases', ['Spanish Basics'])).toBe('Korean Phrases');
  });

  test('appends "(imported)" on a first collision', () => {
    expect(uniqueImportDeckName('Korean Phrases', ['Korean Phrases'])).toBe('Korean Phrases (imported)');
  });

  test('counts up past repeated collisions', () => {
    const existing = ['Korean Phrases', 'Korean Phrases (imported)', 'Korean Phrases (imported 2)'];
    expect(uniqueImportDeckName('Korean Phrases', existing)).toBe('Korean Phrases (imported 3)');
  });

  test('is case-insensitive', () => {
    expect(uniqueImportDeckName('korean phrases', ['Korean Phrases'])).toBe('korean phrases (imported)');
  });
});
