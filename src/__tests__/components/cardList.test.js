import React from 'react';
import { render, screen } from '@testing-library/react';
import CardList from '../../components/Card/CardList';
import { useDecks } from '../../contexts/DeckContext';

jest.mock('../../contexts/DeckContext');
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'deck1' }),
  useRouter: () => ({ push: jest.fn() })
}));
// The form and the modal each pull in the generation context and the audio
// stack; neither is what this file is about.
jest.mock('../../components/Card/CardForm', () => {
  const CardFormStub = () => <div data-testid="card-form" />;
  return CardFormStub;
});
jest.mock('../../components/Card/CardModal', () => {
  const CardModalStub = () => null;
  return CardModalStub;
});

const deck = {
  id: 'deck1',
  name: 'Korean Phrases',
  known_language: 'en',
  learning_language: 'ko',
  // The review queue: what today's session would serve, which is not the deck.
  cards: []
};

const renderList = (library) => {
  const loadDeckCards = jest.fn();
  useDecks.mockReturnValue({
    decks: { deck1: deck },
    deckCards: library ? { deck1: library } : {},
    loadDeckCards,
    setCurrentDeckId: jest.fn(),
    deleteCard: jest.fn()
  });
  render(<CardList />);
  return { loadDeckCards };
};

describe('the deck card list', () => {
  test('asks for the whole deck, not the review queue', () => {
    const { loadDeckCards } = renderList({ cards: [], loading: true, error: null });
    expect(loadDeckCards).toHaveBeenCalledWith('deck1');
  });

  test('shows cards the review queue would not serve', () => {
    renderList({
      cards: [
        {
          id: 'c1',
          front_text: 'Hello',
          review: { card_state: 'review', next_review_date: '2099-01-01T00:00:00.000Z', interval_days: 30, ease_factor: 2.5, lapses: 0 }
        }
      ],
      loading: false,
      error: null
    });

    // A fully reviewed deck used to report itself empty on its own edit page.
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByText('No cards in this deck yet.')).not.toBeInTheDocument();
  });

  test('renders the schedule a loaded card actually carries', () => {
    renderList({
      cards: [
        {
          id: 'c1',
          front_text: 'Hello',
          review: {
            card_state: 'review',
            next_review_date: '2099-03-04T00:00:00.000Z',
            interval_days: 30,
            ease_factor: 2.34,
            lapses: 2
          }
        }
      ],
      loading: false,
      error: null
    });

    const stats = document.querySelector('.card-stats');
    expect(stats).not.toBeNull();
    expect(stats.textContent).toContain('Interval: 30 days');
    expect(stats.textContent).toContain('Ease: 2.34');
    expect(stats.textContent).toContain('Lapses: 2');
    expect(stats.textContent).toContain(new Date('2099-03-04T00:00:00.000Z').toLocaleDateString());
  });

  test('a card with no review yet reads as new rather than rendering nothing', () => {
    renderList({ cards: [{ id: 'c1', front_text: 'Hello', review: null }], loading: false, error: null });

    expect(document.querySelector('.card-stats').textContent).toContain('New - not studied yet');
  });

  test('does not claim the deck is empty before the read comes back', () => {
    renderList({ cards: [], loading: true, error: null });

    expect(screen.getByText('Loading cards…')).toBeInTheDocument();
    expect(screen.queryByText('No cards in this deck yet.')).not.toBeInTheDocument();
  });

  test('says the deck is empty once it really is', () => {
    renderList({ cards: [], loading: false, error: null });

    expect(screen.getByText('No cards in this deck yet.')).toBeInTheDocument();
  });

  test('surfaces a failed read instead of showing it as an empty deck', () => {
    renderList({ cards: [], loading: false, error: 'network down' });

    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });
});
