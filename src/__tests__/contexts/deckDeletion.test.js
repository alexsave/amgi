import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { DeckProvider, useDecks } from '../../contexts/DeckContext';
import { useAuth } from '../../contexts/AuthContext';
import * as supabase from '../../db/supabase';
import * as api from '../../network/supabaseApi';

jest.mock('../../contexts/AuthContext');
jest.mock('../../db/supabase');
jest.mock('../../network/supabaseApi');

const wrapper = ({ children }) => <DeckProvider>{children}</DeckProvider>;

// A translation pair, the way CardModal builds one: two cards pointing at the
// same two audio objects, crosswise. Which of them may be removed is the
// server's call, so the context must never shortcut it.
const decksFixture = () => ({
  deck1: {
    id: 'deck1',
    name: 'Deck 1',
    known_language: 'en',
    learning_language: 'ko',
    cards: [
      { id: 'cardA', front_text: 'Hello', back_text: '안녕하세요', front_audio_path: 'x.mp3', back_audio_path: 'y.mp3' },
      { id: 'cardB', front_text: '안녕하세요', back_text: 'Hello', front_audio_path: 'y.mp3', back_audio_path: 'x.mp3' }
    ]
  }
});

const loadedDecks = async () => {
  const { result } = renderHook(() => useDecks(), { wrapper });
  await waitFor(() => expect(result.current.decks.deck1).toBeDefined());
  return result;
};

describe('deck and card deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.mockReturnValue({ user: { id: 'user1' } });
    supabase.loadDecks.mockResolvedValue(decksFixture());
    supabase.loadDailyNewCardBudget.mockResolvedValue({ limit: 20, used: 0, remaining: 20 });
    api.deleteCards.mockResolvedValue({ deleted_audio: [], missing_audio: [] });
    api.deleteDeck.mockResolvedValue({ deleted_audio: ['x.mp3', 'y.mp3'], missing_audio: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it('deletes a single card through the audio-aware endpoint', async () => {
    const result = await loadedDecks();

    await act(async () => {
      await result.current.deleteCard('deck1', 'cardA');
    });

    expect(api.deleteCards).toHaveBeenCalledWith(['cardA']);
    expect(result.current.decks.deck1.cards.map(card => card.id)).toEqual(['cardB']);
  });

  it('keeps the card when the server refuses the delete', async () => {
    api.deleteCards.mockRejectedValue(new Error('nope'));
    const result = await loadedDecks();

    await act(async () => {
      await expect(result.current.deleteCard('deck1', 'cardA')).rejects.toThrow('nope');
    });

    expect(result.current.decks.deck1.cards.map(card => card.id)).toEqual(['cardA', 'cardB']);
  });

  it('deletes a deck through the audio-aware endpoint', async () => {
    const result = await loadedDecks();

    await act(async () => {
      await result.current.deleteDeck('deck1');
    });

    expect(api.deleteDeck).toHaveBeenCalledWith('deck1');
    expect(result.current.decks.deck1).toBeUndefined();
  });

  it('keeps the deck when the server refuses the delete', async () => {
    api.deleteDeck.mockRejectedValue(new Error('nope'));
    const result = await loadedDecks();

    await act(async () => {
      await expect(result.current.deleteDeck('deck1')).rejects.toThrow('nope');
    });

    expect(result.current.decks.deck1).toBeDefined();
  });

  it('never drops deck or card rows without going through the server', async () => {
    const result = await loadedDecks();

    await act(async () => {
      await result.current.deleteCard('deck1', 'cardA');
      await result.current.deleteDeck('deck1');
    });

    // A direct table delete would strand the audio in a public bucket.
    expect(supabase.deleteDeck).toBeUndefined();
    expect(supabase.deleteCard).toBeUndefined();
  });
});
