import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { ReviewProvider, useReview } from '../../contexts/ReviewContext';
import { useDecks } from '../../contexts/DeckContext';
import { useAuth } from '../../contexts/AuthContext';
import * as supabase from '../../db/supabase';

jest.mock('../../contexts/DeckContext');
jest.mock('../../contexts/AuthContext');
jest.mock('../../db/supabase');

const NOW = new Date('2024-01-01T12:00:00Z');

const wrapper = ({ children }) => <ReviewProvider>{children}</ReviewProvider>;

const minutesFromNow = (mins) => new Date(NOW.getTime() + mins * 60 * 1000).toISOString();

const deckWith = (cards) => ({
  currentDeckId: 'deck1',
  decks: {
    deck1: {
      id: 'deck1',
      name: 'Deck 1',
      known_language: 'en',
      learning_language: 'ko',
      cards
    }
  },
  updateDeckCards: jest.fn()
});

// Factory: the scheduler mutates card objects, so every test needs fresh ones
const defaultCards = () => [
  {
    id: 'card1',
    front_text: 'Front 1',
    back_text: 'Back 1',
    review: null // New card
  },
  {
    id: 'card2',
    front_text: 'Front 2',
    back_text: 'Back 2',
    review: {
      card_state: 'learning',
      next_review_date: NOW.toISOString(),
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5
    }
  },
  {
    id: 'card3',
    front_text: 'Front 3',
    back_text: 'Back 3',
    review: {
      card_state: 'review',
      next_review_date: NOW.toISOString(),
      interval_days: 5,
      repetitions: 3,
      ease_factor: 2.5
    }
  }
];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();

  useDecks.mockReturnValue(deckWith(defaultCards()));
  useAuth.mockReturnValue({ user: { id: 'user1' } });
  supabase.saveReview.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useReview', () => {
  describe('initialization', () => {
    test('initializes with correct card counts', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.newCardsCount).toBe(1);
      expect(result.current.learningCardsCount).toBe(1);
      expect(result.current.reviewCardsCount).toBe(1);
    });

    test('starts with the learning card that is due now', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card2');
    });

    test('handles an empty deck', () => {
      useDecks.mockReturnValue(deckWith([]));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard).toBeNull();
      expect(result.current.newCardsCount).toBe(0);
      expect(result.current.learningCardsCount).toBe(0);
      expect(result.current.reviewCardsCount).toBe(0);
    });
  });

  describe('review flow', () => {
    test('correct answer on a learning card graduates it and saves the review', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card2');

      act(() => {
        result.current.markCorrectGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({ card_state: 'review' }),
        'user1'
      );

      // card2 graduated out of the session; next up is the new card
      expect(result.current.learningCardsCount).toBe(0);
      expect(result.current.currentCard?.id).toBe('card1');
    });

    test('correct answer on a new card moves it to learning', () => {
      useDecks.mockReturnValue(deckWith([defaultCards()[0]]));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card1');

      act(() => {
        result.current.markCorrectGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card1',
        expect.objectContaining({ card_state: 'learning' }),
        'user1'
      );
      expect(result.current.newCardsCount).toBe(0);
      expect(result.current.learningCardsCount).toBe(1);
    });

    test('incorrect answer with attempts remaining keeps the same card', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markIncorrectGetNext();
      });

      expect(result.current.attempts).toBe(1);
      expect(result.current.currentCard?.id).toBe('card2');
      // Nothing is persisted until the card actually advances
      expect(supabase.saveReview).not.toHaveBeenCalled();
    });

    test('incorrect answer at max attempts reschedules and advances', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markIncorrectGetNext();
      });
      act(() => {
        result.current.markIncorrectGetNext();
      });
      act(() => {
        result.current.markIncorrectGetNext();
      });

      expect(result.current.attempts).toBe(0);
      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({ card_state: 'learning' }),
        'user1'
      );
      // The failed card goes back into learning (due in 10 min) and the next
      // card is served
      expect(result.current.learningCardsCount).toBe(1);
      expect(result.current.currentCard?.id).toBe('card1');
    });
  });

  describe('markAgainGetNext', () => {
    test('reschedules the card as a miss and advances immediately', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card2');

      act(() => {
        result.current.markAgainGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({
          card_state: 'learning',
          next_review_date: minutesFromNow(10)
        }),
        'user1'
      );

      // No retries: the very first "again" both reschedules and moves on
      expect(result.current.attempts).toBe(0);
      expect(result.current.currentCard?.id).toBe('card1');
      expect(result.current.learningCardsCount).toBe(1);
    });

    test('advances no matter how many attempts were already made', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markIncorrectGetNext();
      });
      act(() => {
        result.current.markIncorrectGetNext();
      });
      expect(result.current.attempts).toBe(2);
      expect(result.current.currentCard?.id).toBe('card2');

      act(() => {
        result.current.markAgainGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledTimes(1);
      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({
          card_state: 'learning',
          next_review_date: minutesFromNow(10)
        }),
        'user1'
      );
      expect(result.current.attempts).toBe(0);
      expect(result.current.currentCard?.id).toBe('card1');
    });

    test('a missed review card drops its ease and falls back to learning', () => {
      useDecks.mockReturnValue(deckWith([defaultCards()[2]]));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card3');

      act(() => {
        result.current.markAgainGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card3',
        expect.objectContaining({
          card_state: 'learning',
          interval_days: 1,
          ease_factor: 2.3,
          next_review_date: minutesFromNow(10)
        }),
        'user1'
      );
      expect(result.current.reviewCardsCount).toBe(0);
      expect(result.current.learningCardsCount).toBe(1);
      // It is the only card left, so the scheduler serves it again early
      // rather than ending the session
      expect(result.current.currentCard?.id).toBe('card3');
      expect(result.current.attempts).toBe(0);
    });
  });
});
