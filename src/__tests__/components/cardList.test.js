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

  test('offers both recordings as playable chips, named by language', () => {
    // "🔊 has audio" told you a clip existed and gave you no way to hear it,
    // which was the one check worth making before a card reaches your
    // reviews. Each clip is a button now, and it carries its own language
    // name because two bare play icons cannot say which is which.
    renderList({
      cards: [{
        id: 1,
        notetypeName: 'amgi Listening',
        front_text: '안녕하세요',
        hasAudio: true,
        fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio'],
        fields: ['hello', '<audio src="cue-1.mp3"></audio>', '안녕하세요', '<audio src="target-1.mp3"></audio>'],
      }],
      loading: false,
      error: null,
    });

    expect(screen.getByText('안녕하세요')).toBeInTheDocument();
    // The cue side is the OTHER language, read out of the Cue field. It used
    // to render back_text, which is the audio field with its HTML stripped -
    // ie. nothing at all for an <audio src> reference, so the column was
    // simply blank.
    expect(screen.getByText('hello')).toBeInTheDocument();
    // And the note type is not repeated on every row: on an amgi deck every
    // row is the same type, so printing it thirty times says nothing.
    expect(screen.queryByText('amgi Listening')).not.toBeInTheDocument();
    const chips = document.querySelectorAll('.audio-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('English');
    expect(chips[1].textContent).toContain('한국어');
  });

  test('offers no chip for a field that holds no clip', () => {
    // A field can exist and be empty - a deck half-filled by the audio
    // repair screen looks exactly like this - and a play button that plays
    // nothing is worse than no button.
    renderList({
      cards: [{
        id: 1,
        notetypeName: 'amgi Listening',
        front_text: '안녕하세요',
        hasAudio: true,
        fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio'],
        fields: ['hello', '', '안녕하세요', '<audio src="target-1.mp3"></audio>'],
      }],
      loading: false,
      error: null,
    });

    expect(document.querySelectorAll('.audio-chip')).toHaveLength(1);
  });

  test('says an amgi note has no audio yet rather than hiding that', () => {
    renderList({
      cards: [{
        id: 1,
        notetypeName: 'amgi Listening',
        front_text: '안녕하세요',
        hasAudio: false,
        fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio'],
        fields: ['hello', '', '안녕하세요', ''],
      }],
      loading: false,
      error: null,
    });

    expect(screen.getByText('no audio yet')).toBeInTheDocument();
    expect(document.querySelectorAll('.audio-chip')).toHaveLength(0);
  });

  test('marks a note amgi did not make, and names its note type', () => {
    // A deck can hold anything. Listing these keeps the count honest against
    // Anki rather than making the deck look emptier here than it is, but
    // they are marked, because amgi cannot edit or record them.
    renderList({
      cards: [{
        id: 1,
        notetypeName: 'Basic',
        front_text: 'Meeting notes from work',
        hasAudio: false,
        fieldNames: ['Front', 'Back'],
        fields: ['Meeting notes from work', 'something'],
      }],
      loading: false,
      error: null,
    });

    expect(screen.getByText('Basic')).toBeInTheDocument();
    expect(screen.getByText(/not an amgi card/)).toBeInTheDocument();
    expect(document.querySelectorAll('.audio-chip')).toHaveLength(0);
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
