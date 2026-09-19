import React from 'react';
import { render, screen } from '@testing-library/react';
import CardList from '../../components/Card/CardList';
import { useDecks } from '../../contexts/DeckContext';

jest.mock('../../contexts/DeckContext');
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'deck1' }),
  useRouter: () => ({ push: jest.fn() })
}));
// The form pulls in ankiApi and the field-mapping guess; neither is what
// this file is about - it is about what the note list itself renders.
jest.mock('../../components/Card/CardForm', () => {
  const CardFormStub = () => <div data-testid="card-form" />;
  return CardFormStub;
});

const deck = { id: 'deck1', name: 'Korean Phrases', noteCount: 1 };

const renderList = (library) => {
  const loadDeckCards = jest.fn();
  useDecks.mockReturnValue({
    decks: { deck1: deck },
    deckCards: library ? { deck1: library } : {},
    loadDeckCards,
    setCurrentDeckId: jest.fn(),
  });
  render(<CardList />);
  return { loadDeckCards };
};

describe('the deck card list', () => {
  test('asks for the first page, not the whole deck at once', () => {
    const { loadDeckCards } = renderList({ cards: [], loading: true, error: null });
    // Pagination that survives a large Anki deck - one page fetched at a
    // time, not the whole deck loaded up front.
    expect(loadDeckCards).toHaveBeenCalledWith('deck1', { offset: 0, limit: 20 });
  });

  test('renders a note with its note type and audio status', () => {
    renderList({
      cards: [{ id: 1, notetypeName: "Retro's sentences", front_text: '안녕하세요', hasAudio: true }],
      loading: false,
      error: null,
    });

    expect(screen.getByText('안녕하세요')).toBeInTheDocument();
    expect(screen.getByText("Retro's sentences")).toBeInTheDocument();
    expect(screen.getByText('🔊 has audio')).toBeInTheDocument();
    expect(document.querySelector('.card-stats').textContent).toContain('Scheduled in Anki');
  });

  test('says a note has no audio yet rather than hiding that', () => {
    renderList({
      cards: [{ id: 1, notetypeName: 'Basic', front_text: 'hello', hasAudio: false }],
      loading: false,
      error: null,
    });

    expect(screen.getByText('no audio yet')).toBeInTheDocument();
  });

  test('does not claim the deck is empty before the read comes back', () => {
    renderList({ cards: [], loading: true, error: null });

    expect(screen.getByText('Loading notes…')).toBeInTheDocument();
    expect(screen.queryByText('No notes in this deck yet.')).not.toBeInTheDocument();
  });

  test('says the deck is empty once it really is', () => {
    renderList({ cards: [], loading: false, error: null });

    expect(screen.getByText('No notes in this deck yet.')).toBeInTheDocument();
  });

  test('surfaces a failed read instead of showing it as an empty deck', () => {
    renderList({ cards: [], loading: false, error: 'network down' });

    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });
});
