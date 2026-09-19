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
const daysFromNow = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const deckWith = (cards, extras = {}) => ({
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
  updateDeckCards: jest.fn(),
  ...extras
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
      // On the last learning step, so one Good graduates it
      learning_step: 1,
      next_review_date: NOW.toISOString(),
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5,
      lapses: 0
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
      ease_factor: 2.5,
      lapses: 0
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
    test('correct answer on the last learning step graduates the card and saves the review', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('card2');

      act(() => {
        result.current.markCorrectGetNext();
      });

      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({ card_state: 'review', next_review_date: daysFromNow(1) }),
        'user1',
        expect.anything()
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
        expect.objectContaining({
          card_state: 'learning',
          learning_step: 1,
          next_review_date: minutesFromNow(10)
        }),
        'user1',
        expect.anything()
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
        'user1',
        expect.anything()
      );
      // The failed card goes back to the first learning step and the next
      // card is served
      expect(result.current.learningCardsCount).toBe(1);
      expect(result.current.currentCard?.id).toBe('card1');
    });

    test('session control flags are never persisted', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });

      const [, payload] = supabase.saveReview.mock.calls[0];
      expect(payload).not.toHaveProperty('shouldReschedule');
      expect(payload).not.toHaveProperty('resetAttempts');
      expect(payload).not.toHaveProperty('shouldGoToNextCard');
    });
  });

  describe('review log', () => {
    test('every grade logs the state the card was in before it', () => {
      useDecks.mockReturnValue(deckWith([defaultCards()[2]]));

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markAgainGetNext();
      });

      const [, , , log] = supabase.saveReview.mock.calls[0];
      expect(log).toEqual({
        id: expect.any(String),
        reviewed_at: NOW.toISOString(),
        rating: 'again',
        card_state: 'review',
        interval_days: 5,
        ease_factor: 2.5,
        repetitions: 3,
        elapsed_days: null,
        scheduled_days: 5
      });
    });

    test('a good answer is logged as good', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });

      const [, , , log] = supabase.saveReview.mock.calls[0];
      expect(log.rating).toBe('good');
      expect(log.card_state).toBe('learning');
    });

    test('a card answered twice in one session has elapsed time, not a gap', async () => {
      useDecks.mockReturnValue(deckWith([defaultCards()[0]]));

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });
      act(() => {
        result.current.markAgainGetNext();
      });

      // Saves are serialized, so the second one is sent once the first lands.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });

      const [, payload] = supabase.saveReview.mock.calls[0];
      expect(payload.last_reviewed_at).toBe(NOW.toISOString());

      // null would claim the card had never been reviewed before
      const [, , , log] = supabase.saveReview.mock.calls[1];
      expect(log.elapsed_days).toBe(0);
      expect(log.card_state).toBe('learning');
    });

    test('retries that do not grade the card are not logged', () => {
      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markIncorrectGetNext();
      });

      expect(supabase.saveReview).not.toHaveBeenCalled();
    });
  });

  describe('daily new-card limit', () => {
    const newCards = () => [
      { id: 'new1', front_text: 'A', back_text: 'B', review: null },
      { id: 'new2', front_text: 'C', back_text: 'D', review: null }
    ];

    test('the budget from the deck context caps what the session introduces', () => {
      useDecks.mockReturnValue(deckWith(newCards(), { newCardBudget: 1 }));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.newCardsCount).toBe(1);
      expect(result.current.currentCard?.id).toBe('new1');

      act(() => {
        result.current.markCorrectGetNext();
      });

      // new1 comes back on its learning step; new2 is over today's limit and
      // never appears
      expect(result.current.newCardsCount).toBe(0);
      expect(result.current.currentCard?.id).toBe('new1');
    });

    test('an exhausted budget hides new cards entirely', () => {
      useDecks.mockReturnValue(deckWith(newCards(), { newCardBudget: 0 }));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.newCardsCount).toBe(0);
      expect(result.current.currentCard).toBeNull();
    });

    test('a missing budget falls back to the default cap rather than blocking', () => {
      useDecks.mockReturnValue(deckWith(newCards()));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.newCardsCount).toBe(2);
    });
  });

  describe('persisting answers', () => {
    // The learner never waits on the network, so every assertion here is about
    // what happens after the card has already advanced.
    const settle = async () => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60000);
      });
    };

    test('the answer is not lost when the request fails', async () => {
      supabase.saveReview
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({});

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });

      // The next card is served immediately, failure or not
      expect(result.current.currentCard?.id).toBe('card1');

      await settle();

      expect(supabase.saveReview).toHaveBeenCalledTimes(2);
      expect(result.current.saveState).toEqual({ pending: 0, failed: 0, lastError: null });
    });

    test('a retry resends the same log row id, so the log cannot be written twice', async () => {
      supabase.saveReview
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({});

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });
      await settle();

      const [, , , first] = supabase.saveReview.mock.calls[0];
      const [, , , second] = supabase.saveReview.mock.calls[1];
      expect(first.id).toEqual(expect.any(String));
      expect(second.id).toBe(first.id);
    });

    test('two rapid grades are sent one at a time, oldest first', async () => {
      useDecks.mockReturnValue(deckWith(defaultCards()));

      let release;
      supabase.saveReview.mockImplementationOnce(
        () => new Promise((resolve) => { release = resolve; })
      );

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });
      act(() => {
        result.current.markCorrectGetNext();
      });

      // The second answer waits: sending both at once could land them in the
      // wrong order and leave the older schedule stored.
      expect(supabase.saveReview).toHaveBeenCalledTimes(1);
      expect(result.current.saveState.pending).toBe(2);

      await act(async () => {
        release({});
        await Promise.resolve();
      });

      expect(supabase.saveReview).toHaveBeenCalledTimes(2);
      expect(supabase.saveReview.mock.calls[0][0]).toBe('card2');
      expect(supabase.saveReview.mock.calls[1][0]).toBe('card1');
    });

    test('an answer that never saves is reported rather than silently dropped', async () => {
      supabase.saveReview.mockRejectedValue(new Error('offline'));

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });
      await settle();
      await settle();
      await settle();

      expect(result.current.saveState.failed).toBe(1);
      expect(result.current.saveState.lastError.message).toBe('offline');

      supabase.saveReview.mockResolvedValue({});
      await act(async () => {
        result.current.retryFailedSaves();
        await Promise.resolve();
      });

      expect(result.current.saveState.failed).toBe(0);
    });
  });

  describe('sibling burying', () => {
    const pair = () => [
      { id: 'forward', front_text: 'Thank you', back_text: 'Gomawo', review: null },
      { id: 'reverse', front_text: 'Gomawo', back_text: 'Thank you', review: null },
      { id: 'other', front_text: 'Hello', back_text: 'Annyeong', review: null }
    ];

    test('the reverse card is not shown straight after its forward card', () => {
      useDecks.mockReturnValue(deckWith(pair()));

      const { result } = renderHook(() => useReview(), { wrapper });

      expect(result.current.currentCard?.id).toBe('forward');

      act(() => {
        result.current.markCorrectGetNext();
      });

      // Showing 'reverse' here would be an echo of the answer just heard
      expect(result.current.currentCard?.id).toBe('other');
    });

    test('a buried sibling is still shown when nothing else is left', () => {
      useDecks.mockReturnValue(deckWith(pair().slice(0, 2)));

      const { result } = renderHook(() => useReview(), { wrapper });

      act(() => {
        result.current.markCorrectGetNext();
      });

      expect(result.current.currentCard?.id).toBe('reverse');
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
          learning_step: 0,
          next_review_date: minutesFromNow(1)
        }),
        'user1',
        expect.anything()
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
          next_review_date: minutesFromNow(1)
        }),
        'user1',
        expect.anything()
      );
      expect(result.current.attempts).toBe(0);
      expect(result.current.currentCard?.id).toBe('card1');
    });

    test('a missed review card drops its ease, counts a lapse and falls back to learning', () => {
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
          lapses: 1,
          next_review_date: minutesFromNow(1)
        }),
        'user1',
        expect.anything()
      );
      expect(result.current.reviewCardsCount).toBe(0);
      expect(result.current.learningCardsCount).toBe(1);
      // It is the only card left and its step is within the learn-ahead
      // window, so the scheduler serves it again rather than ending the session
      expect(result.current.currentCard?.id).toBe('card3');
      expect(result.current.attempts).toBe(0);
    });

    test('a card whose step is beyond the learn-ahead window ends the session', () => {
      const card = defaultCards()[2];

      const { result } = renderHook(() => useReview(), {
        wrapper: ({ children }) => {
          useDecks.mockReturnValue(deckWith([card]));
          return <ReviewProvider>{children}</ReviewProvider>;
        }
      });

      act(() => {
        // A 30 minute step is further out than the learn-ahead window
        result.current.cardSchedulerRef.current.setReviewTime(
          result.current.currentCard,
          NOW.getTime() + 30 * 60 * 1000,
          'learning'
        );
      });

      expect(result.current.cardSchedulerRef.current.peekNext()).toBeNull();
    });
  });
});
