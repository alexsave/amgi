import { renderHook, act } from '@testing-library/react-hooks';
import { useReview } from '../../contexts/ReviewContext';
import { useDecks } from '../../contexts/DeckContext';
import { useAuth } from '../../contexts/AuthContext';
import * as supabase from '../../db/supabase';

// Mock dependencies
jest.mock('../../contexts/DeckContext');
jest.mock('../../contexts/AuthContext');
jest.mock('../../db/supabase');

// Mock current date for consistent testing
let mockDate;
const RealDate = Date;

beforeAll(() => {
  // Ensure timezone doesn't affect our tests
  jest.useFakeTimers();
  process.env.TZ = 'UTC';
});

beforeEach(() => {
  // Start each test at 2024-01-01
  mockDate = new Date('2024-01-01T12:00:00Z');
  
  // Create a proper Date mock that maintains prototype chain
  const MockDate = function(arg) {
    if (arg === undefined) return new RealDate(mockDate);
    return new RealDate(arg);
  };
  MockDate.prototype = RealDate.prototype;
  MockDate.now = () => mockDate.getTime();
  
  // Replace global Date
  global.Date = MockDate;

  // Reset all mocks
  jest.clearAllMocks();

  // Setup default mock values
  useDecks.mockReturnValue({
    currentDeckId: 'deck1',
    decks: {
      deck1: {
        id: 'deck1',
        cards: [
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
              next_review_date: mockDate.toISOString(),
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
              next_review_date: mockDate.toISOString(),
              interval_days: 5,
              repetitions: 3,
              ease_factor: 2.5
            }
          }
        ]
      }
    },
    mode: 'review'
  });

  useAuth.mockReturnValue({
    user: { id: 'user1' },
    isDirectMode: false
  });

  supabase.saveReview.mockResolvedValue({});
});

afterEach(() => {
  global.Date = RealDate;
});

afterAll(() => {
  jest.useRealTimers();
});

describe('useReview', () => {
  describe('Initialization', () => {
    test('initializes with correct card counts', () => {
      const { result } = renderHook(() => useReview());

      expect(result.current.newCardsCount).toBe(1);
      expect(result.current.learningCardsCount).toBe(1);
      expect(result.current.reviewCardsCount).toBe(1);
    });

    test('starts with first due card', () => {
      const { result } = renderHook(() => useReview());

      // Should start with the learning card since it's due now
      expect(result.current.currentCardId).toBe('card2');
    });

    test('handles empty deck', () => {
      useDecks.mockReturnValue({
        currentDeckId: 'deck1',
        decks: { deck1: { id: 'deck1', cards: [] } },
        mode: 'review'
      });

      const { result } = renderHook(() => useReview());

      expect(result.current.currentCardId).toBeNull();
      expect(result.current.newCardsCount).toBe(0);
      expect(result.current.learningCardsCount).toBe(0);
      expect(result.current.reviewCardsCount).toBe(0);
    });
  });

  describe('Card Review Flow', () => {
    test('handles correct answer for new card', async () => {
      useDecks.mockReturnValue({
        currentDeckId: 'deck1',
        decks: {
          deck1: {
            id: 'deck1',
            cards: [
              {
                id: 'card1',
                front_text: 'Front 1',
                back_text: 'Back 1',
                review: null
              }
            ]
          }
        },
        mode: 'review'
      });

      const { result } = renderHook(() => useReview());
      
      expect(result.current.currentCardId).toBe('card1');
      expect(result.current.attempts).toBe(0);

      await act(async () => {
        result.current.markCorrectGetNext();
      });

      // Card should move to learning state with 10 minute delay
      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card1',
        expect.objectContaining({
          result: 'incorrect', // First success treated as incorrect for scheduling
          card_state: 'learning'
        }),
        'user1'
      );

      expect(result.current.learningCardsCount).toBe(1);
      expect(result.current.newCardsCount).toBe(0);
    });

    test('handles incorrect answer within max attempts', async () => {
      const { result } = renderHook(() => useReview());
      
      expect(result.current.currentCardId).toBe('card2');
      expect(result.current.attempts).toBe(0);

      await act(async () => {
        result.current.markIncorrectGetAttempts();
      });

      expect(result.current.attempts).toBe(1);
      expect(result.current.currentCardId).toBe('card2'); // Same card
      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({
          result: 'incorrect'
        }),
        'user1'
      );
    });

    test('handles incorrect answer at max attempts', async () => {
      const { result } = renderHook(() => useReview());

      // Get to max attempts
      await act(async () => {
        result.current.markIncorrectGetAttempts();
        result.current.markIncorrectGetAttempts();
        const final = result.current.markIncorrectGetAttempts();
        expect(final.attempts).toBe(0);
        expect(final.nextCard).not.toBe('card2');
      });

      // Card should be rescheduled in 10 minutes
      expect(result.current.learningCardsCount).toBe(1);
    });

    test('handles correct answer for learning card', async () => {
      const { result } = renderHook(() => useReview());
      
      expect(result.current.currentCardId).toBe('card2');

      await act(async () => {
        result.current.markCorrectGetNext();
      });

      // Card should move to review state
      expect(supabase.saveReview).toHaveBeenCalledWith(
        'card2',
        expect.objectContaining({
          result: 'correct',
          card_state: 'review'
        }),
        'user1'
      );

      expect(result.current.learningCardsCount).toBe(0);
      expect(result.current.reviewCardsCount).toBe(2);
    });
  });

  describe('Direct Mode', () => {
    test('does not save to server in direct mode', async () => {
      useAuth.mockReturnValue({
        user: { id: 'user1' },
        isDirectMode: true
      });

      const { result } = renderHook(() => useReview());
      
      await act(async () => {
        result.current.markCorrectGetNext();
      });

      expect(supabase.saveReview).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    test('handles server error gracefully', async () => {
      supabase.saveReview.mockRejectedValue(new Error('Server error'));

      const { result } = renderHook(() => useReview());
      
      await act(async () => {
        result.current.markCorrectGetNext();
      });

      expect(result.current.error).toBe('Failed to update card scheduling');
    });
  });
}); 