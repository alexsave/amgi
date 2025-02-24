import { calculateNextReview, getDueCards } from '../../algorithms/spacedRepetition';

// Mock current date for consistent testing
let mockDate;
const RealDate = Date;

// Jest setup and teardown
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
});

afterEach(() => {
  jest.clearAllMocks();
  // Restore the real Date
  global.Date = RealDate;
});

afterAll(() => {
  jest.useRealTimers();
});

describe('Spaced Repetition Algorithm', () => {
  describe('calculateNextReview', () => {
    test('handles new card correct response', () => {
      const review = null; // New card has no review history

      const result = calculateNextReview(review, 'correct');
      
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(1);
      expect(result.easeFactor).toBe(2.5);
      
      // Next review should be 10 minutes from now for first success
      const nextReview = new Date(result.nextReview);
      expect(nextReview.getTime() - mockDate.getTime()).toBe(10 * 60 * 1000);
    });

    test('handles learning card correct response', () => {
      const review = {
        interval_days: 1,
        repetitions: 1,
        ease_factor: 2.5,
        card_state: 'learning'
      };

      const result = calculateNextReview(review, 'correct');
      
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(2);
      expect(result.easeFactor).toBe(2.5);
      
      // Next review should be tomorrow
      const nextReview = new Date(result.nextReview);
      expect(nextReview).toEqual(new Date('2024-01-02T12:00:00Z'));
    });

    test('handles review card correct response', () => {
      const review = {
        interval_days: 1,
        repetitions: 2,
        ease_factor: 2.5,
        card_state: 'review'
      };

      const result = calculateNextReview(review, 'correct');
      
      // interval * easeFactor = 1 * 2.5 = 2.5 (rounded to 3)
      expect(result.interval).toBe(3);
      expect(result.repetitions).toBe(3);
      expect(result.easeFactor).toBe(2.5);
      
      // Next review should be 3 days from now
      const nextReview = new Date(result.nextReview);
      expect(nextReview).toEqual(new Date('2024-01-04T12:00:00Z'));
    });

    test('handles incorrect response for new card', () => {
      const review = null;

      const result = calculateNextReview(review, 'incorrect');
      
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(0);
      expect(result.easeFactor).toBe(2.5); // Unchanged for new cards
      
      // Next review should be 10 minutes from now
      const nextReview = new Date(result.nextReview);
      expect(nextReview.getTime() - mockDate.getTime()).toBe(10 * 60 * 1000);
    });

    test('handles incorrect response for learning card', () => {
      const review = {
        interval_days: 1,
        repetitions: 1,
        ease_factor: 2.5,
        card_state: 'learning'
      };

      const result = calculateNextReview(review, 'incorrect');
      
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(1); // Repetitions not reset for learning cards
      expect(result.easeFactor).toBe(2.5); // Unchanged for learning cards
      
      // Next review should be 10 minutes from now
      const nextReview = new Date(result.nextReview);
      expect(nextReview.getTime() - mockDate.getTime()).toBe(10 * 60 * 1000);
    });

    test('handles incorrect response for review card', () => {
      const review = {
        interval_days: 5,
        repetitions: 3,
        ease_factor: 2.5,
        card_state: 'review'
      };

      const result = calculateNextReview(review, 'incorrect');
      
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(3); // Repetitions not reset for review cards
      expect(result.easeFactor).toBe(2.3); // Decreased by 0.2
      
      // Next review should be 10 minutes from now
      const nextReview = new Date(result.nextReview);
      expect(nextReview.getTime() - mockDate.getTime()).toBe(10 * 60 * 1000);
    });

    test('ensures minimum ease factor', () => {
      const review = {
        interval_days: 5,
        repetitions: 3,
        ease_factor: 1.4, // Already close to minimum
        card_state: 'review'
      };

      const result = calculateNextReview(review, 'incorrect');
      
      expect(result.easeFactor).toBe(1.3); // Won't go below 1.3
    });

    test('caps maximum interval at 10 years', () => {
      const review = {
        interval_days: 2000, // Very long interval
        repetitions: 10,
        ease_factor: 2.5,
        card_state: 'review'
      };

      const result = calculateNextReview(review, 'correct');
      
      expect(result.interval).toBe(3650); // 10 years
    });
  });

  describe('getDueCards', () => {
    test('returns new and due cards in correct order', () => {
      const deck = {
        cards: [
          // New card
          {
            created: mockDate.getTime(),
            front_text: "New 1",
            lastReviewed: null,
            nextReview: null
          },
          // Due review card
          {
            created: mockDate.getTime() - 1000,
            front_text: "Review 1",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date('2024-01-01T11:00:00Z').toISOString() // Due 1 hour ago
          },
          // Not due review card
          {
            created: mockDate.getTime() - 2000,
            front_text: "Review 2",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date('2024-01-02T12:00:00Z').toISOString() // Due tomorrow
          },
          // Another new card
          {
            created: mockDate.getTime() + 1000,
            front_text: "New 2",
            lastReviewed: null,
            nextReview: null
          }
        ]
      };

      const maxNewCardsPerDay = 2;
      const newCardsToday = 0;

      const dueCards = getDueCards(deck, maxNewCardsPerDay, newCardsToday);
      
      expect(dueCards).toHaveLength(3); // 2 new cards + 1 due review
      expect(dueCards[0].front_text).toBe("New 1"); // New cards first
      expect(dueCards[1].front_text).toBe("New 2");
      expect(dueCards[2].front_text).toBe("Review 1"); // Then due reviews
    });

    test('respects max new cards per day limit', () => {
      const deck = {
        cards: [
          { created: mockDate.getTime(), front_text: "New 1", lastReviewed: null },
          { created: mockDate.getTime() + 1000, front_text: "New 2", lastReviewed: null },
          { created: mockDate.getTime() + 2000, front_text: "New 3", lastReviewed: null }
        ]
      };

      const maxNewCardsPerDay = 2;
      const newCardsToday = 1; // Already seen 1 new card

      const dueCards = getDueCards(deck, maxNewCardsPerDay, newCardsToday);
      
      expect(dueCards).toHaveLength(1); // Only 1 new card left for today
      expect(dueCards[0].front_text).toBe("New 1");
    });

    test('handles cards due in minutes', () => {
      const deck = {
        cards: [
          // Due in 10 minutes
          {
            front_text: "Review Soon",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 10 * 60 * 1000).toISOString()
          },
          // Due now
          {
            front_text: "Review Now",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          }
        ]
      };

      let dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(1);
      expect(dueCards[0].front_text).toBe("Review Now");

      // Advance 11 minutes - both cards should now be due
      mockDate = new Date(mockDate.getTime() + 11 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(2);
      expect(dueCards.map(c => c.front_text)).toEqual(["Review Now", "Review Soon"]);
    });

    test('handles complex card ordering with mixed types', () => {
      const deck = {
        cards: [
          // New cards
          {
            front_text: "New 1",
            created: mockDate.getTime(),
            lastReviewed: null
          },
          {
            front_text: "New 2",
            created: mockDate.getTime() + 1000,
            lastReviewed: null
          },
          // Due in minutes
          {
            front_text: "Due Soon 1",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 5 * 60 * 1000).toISOString()
          },
          {
            front_text: "Due Soon 2",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 10 * 60 * 1000).toISOString()
          },
          // Due now
          {
            front_text: "Due Now",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          },
          // Due in future
          {
            front_text: "Due Later",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date(mockDate.getTime() + 24 * 60 * 60 * 1000).toISOString() // Due tomorrow
          }
        ]
      };

      // Initial check - should show new cards and due now card
      let dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(3); // 2 new cards + 1 due now
      expect(dueCards.map(c => c.front_text)).toEqual(["New 1", "New 2", "Due Now"]);

      // Advance 6 minutes - should only show review cards since we've hit new card limit
      mockDate = new Date(mockDate.getTime() + 6 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 10); // Already seen max new cards
      expect(dueCards).toHaveLength(2); // Due Now + Due Soon 1
      expect(dueCards.map(c => c.front_text)).toEqual(["Due Now", "Due Soon 1"]);

      // Advance another 5 minutes - should show all due review cards
      mockDate = new Date(mockDate.getTime() + 5 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 10);
      expect(dueCards).toHaveLength(3); // Due Now + both Due Soon cards
      expect(dueCards.map(c => c.front_text)).toEqual(["Due Now", "Due Soon 1", "Due Soon 2"]);
    });

    test('handles edge cases', () => {
      const deck = {
        cards: [
          // Edge case: undefined dates
          {
            front_text: "Bad Data 1",
            lastReviewed: mockDate.toISOString(),
            nextReview: undefined
          },
          // Edge case: invalid date string
          {
            front_text: "Bad Data 2",
            lastReviewed: mockDate.toISOString(),
            nextReview: "invalid-date"
          },
          // Edge case: null dates
          {
            front_text: "Bad Data 3",
            lastReviewed: null,
            nextReview: null
          },
          // Valid card for comparison
          {
            front_text: "Good Data",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          }
        ]
      };

      const dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(2); // Bad Data 3 (treated as new) + Good Data
      expect(dueCards.map(c => c.front_text)).toEqual(["Bad Data 3", "Good Data"]);
    });
  });
}); 