import { STARTER_DECKS } from '../../data/starterDecks';
import { LANGUAGES } from '../../constants/languages';

describe('starter decks', () => {
  test('template ids are unique', () => {
    const ids = STARTER_DECKS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(STARTER_DECKS.map(d => [d.id, d]))('%s is well-formed', (_id, deck) => {
    expect(deck.name).toBeTruthy();
    expect(deck.description).toBeTruthy();
    expect(LANGUAGES[deck.known_language]).toBeDefined();
    expect(LANGUAGES[deck.learning_language]).toBeDefined();
    expect(deck.cards.length).toBeGreaterThanOrEqual(20);

    for (const card of deck.cards) {
      expect(card.front_text?.trim()).toBeTruthy();
      expect(card.back_text?.trim()).toBeTruthy();
    }

    // No duplicate targets — duplicate back_text makes speech evaluation
    // ambiguous between cards
    const backs = deck.cards.map(c => c.back_text);
    expect(new Set(backs).size).toBe(backs.length);
  });
});
