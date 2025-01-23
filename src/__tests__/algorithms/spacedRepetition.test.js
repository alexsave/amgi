import { updateCardScheduling, getDueCards } from '../../algorithms/spacedRepetition';

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
  describe('updateCardScheduling', () => {
    test('handles new card correct response', () => {
      const card = {
        interval: 1,
        repetitions: 0,
        easeFactor: 2.5,
        lastReviewed: null,
        nextReview: null
      };

      const result = updateCardScheduling(card, 'correct');
      
      expect(result.interval).toBe(1); // First interval
      expect(result.repetitions).toBe(1);
      expect(result.easeFactor).toBe(2.5); // Unchanged for first review
      expect(new Date(result.nextReview)).toEqual(new Date('2024-01-02T12:00:00Z')); // Next day
      expect(result.lastReviewed).toBe(mockDate.toISOString());
    });

    test('handles second correct response', () => {
      const card = {
        interval: 1,
        repetitions: 1,
        easeFactor: 2.5,
        lastReviewed: mockDate.toISOString(),
        nextReview: new Date('2024-01-02T12:00:00Z').toISOString()
      };

      const result = updateCardScheduling(card, 'correct');
      
      expect(result.interval).toBe(6); // Second interval
      expect(result.repetitions).toBe(2);
      expect(result.easeFactor).toBe(2.5);
      expect(new Date(result.nextReview)).toEqual(new Date('2024-01-07T12:00:00Z')); // 6 days later
    });

    test('handles third+ correct response with ease factor', () => {
      const card = {
        interval: 6,
        repetitions: 2,
        easeFactor: 2.5,
        lastReviewed: mockDate.toISOString(),
        nextReview: new Date('2024-01-07T12:00:00Z').toISOString()
      };

      const result = updateCardScheduling(card, 'correct');
      
      // interval * easeFactor = 6 * 2.5 = 15
      expect(result.interval).toBe(15);
      expect(result.repetitions).toBe(3);
      expect(result.easeFactor).toBe(2.5);
      expect(new Date(result.nextReview)).toEqual(new Date('2024-01-16T12:00:00Z'));
    });

    test('handles incorrect response', () => {
      const card = {
        interval: 6,
        repetitions: 2,
        easeFactor: 2.5,
        lastReviewed: mockDate.toISOString(),
        nextReview: new Date('2024-01-07T12:00:00Z').toISOString()
      };

      const result = updateCardScheduling(card, 'incorrect');
      
      expect(result.interval).toBe(1); // Reset to 1
      expect(result.repetitions).toBe(0); // Reset to 0
      expect(result.easeFactor).toBe(2.3); // Decreased by 0.2
      expect(result.dueTimestamp).toBeDefined(); // Should be set for 10 minutes
      const dueDate = new Date(result.dueTimestamp);
      expect(dueDate.getTime() - mockDate.getTime()).toBe(10 * 60 * 1000); // 10 minutes later
    });

    test('handles late review bonus', () => {
      const card = {
        interval: 6,
        repetitions: 2,
        easeFactor: 2.5,
        lastReviewed: mockDate.toISOString(),
        nextReview: new Date('2024-01-04T12:00:00Z').toISOString() // Due 3 days ago
      };

      // Set current date to 3 days after due date
      mockDate = new Date('2024-01-07T12:00:00Z');
      
      const result = updateCardScheduling(card, 'correct');
      
      // interval * (1 + 0.2 * daysLate) * easeFactor = 6 * 1.6 * 2.5 = 24
      expect(result.interval).toBe(24);
      expect(result.repetitions).toBe(3);
      expect(result.easeFactor).toBe(2.5);
      expect(new Date(result.nextReview)).toEqual(new Date('2024-01-31T12:00:00Z'));
    });
  });

  describe('getDueCards', () => {
    test('returns new and due cards in correct order', () => {
      const deck = {
        cards: [
          // New card
          {
            created: mockDate.getTime(),
            frontText: "New 1",
            lastReviewed: null,
            nextReview: null
          },
          // Due review card
          {
            created: mockDate.getTime() - 1000,
            frontText: "Review 1",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date('2024-01-01T11:00:00Z').toISOString() // Due 1 hour ago
          },
          // Not due review card
          {
            created: mockDate.getTime() - 2000,
            frontText: "Review 2",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date('2024-01-02T12:00:00Z').toISOString() // Due tomorrow
          },
          // Another new card
          {
            created: mockDate.getTime() + 1000,
            frontText: "New 2",
            lastReviewed: null,
            nextReview: null
          }
        ]
      };

      const maxNewCardsPerDay = 2;
      const newCardsToday = 0;

      const dueCards = getDueCards(deck, maxNewCardsPerDay, newCardsToday);
      
      expect(dueCards).toHaveLength(3); // 2 new cards + 1 due review
      expect(dueCards[0].frontText).toBe("New 1"); // New cards first
      expect(dueCards[1].frontText).toBe("New 2");
      expect(dueCards[2].frontText).toBe("Review 1"); // Then due reviews
    });

    test('respects max new cards per day limit', () => {
      const deck = {
        cards: [
          { created: mockDate.getTime(), frontText: "New 1", lastReviewed: null },
          { created: mockDate.getTime() + 1000, frontText: "New 2", lastReviewed: null },
          { created: mockDate.getTime() + 2000, frontText: "New 3", lastReviewed: null }
        ]
      };

      const maxNewCardsPerDay = 2;
      const newCardsToday = 1; // Already seen 1 new card

      const dueCards = getDueCards(deck, maxNewCardsPerDay, newCardsToday);
      
      expect(dueCards).toHaveLength(1); // Only 1 new card left for today
      expect(dueCards[0].frontText).toBe("New 1");
    });

    test('handles cards due in minutes', () => {
      const deck = {
        cards: [
          // Due in 10 minutes
          {
            frontText: "Review Soon",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 10 * 60 * 1000).toISOString()
          },
          // Due now
          {
            frontText: "Review Now",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          }
        ]
      };

      let dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(1);
      expect(dueCards[0].frontText).toBe("Review Now");

      // Advance 11 minutes - both cards should now be due
      mockDate = new Date(mockDate.getTime() + 11 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(2);
      expect(dueCards.map(c => c.frontText)).toEqual(["Review Now", "Review Soon"]);
    });

    test('handles complex card ordering with mixed types', () => {
      const deck = {
        cards: [
          // New cards
          {
            frontText: "New 1",
            created: mockDate.getTime(),
            lastReviewed: null
          },
          {
            frontText: "New 2",
            created: mockDate.getTime() + 1000,
            lastReviewed: null
          },
          // Due in minutes
          {
            frontText: "Due Soon 1",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 5 * 60 * 1000).toISOString()
          },
          {
            frontText: "Due Soon 2",
            lastReviewed: mockDate.toISOString(),
            dueTimestamp: new Date(mockDate.getTime() + 10 * 60 * 1000).toISOString()
          },
          // Due now
          {
            frontText: "Due Now",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          },
          // Due in future
          {
            frontText: "Due Later",
            lastReviewed: mockDate.toISOString(),
            nextReview: new Date(mockDate.getTime() + 24 * 60 * 60 * 1000).toISOString() // Due tomorrow
          }
        ]
      };

      // Initial check - should show new cards and due now card
      let dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(3); // 2 new cards + 1 due now
      expect(dueCards.map(c => c.frontText)).toEqual(["New 1", "New 2", "Due Now"]);

      // Advance 6 minutes - should only show review cards since we've hit new card limit
      mockDate = new Date(mockDate.getTime() + 6 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 10); // Already seen max new cards
      expect(dueCards).toHaveLength(2); // Due Now + Due Soon 1
      expect(dueCards.map(c => c.frontText)).toEqual(["Due Now", "Due Soon 1"]);

      // Advance another 5 minutes - should show all due review cards
      mockDate = new Date(mockDate.getTime() + 5 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 10);
      expect(dueCards).toHaveLength(3); // Due Now + both Due Soon cards
      expect(dueCards.map(c => c.frontText)).toEqual(["Due Now", "Due Soon 1", "Due Soon 2"]);
    });

    test('handles far future cards correctly', () => {
      const futureDate = new Date(mockDate.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days in future
      const deck = {
        cards: [
          {
            frontText: "Far Future",
            lastReviewed: mockDate.toISOString(),
            nextReview: futureDate.toISOString()
          },
          {
            frontText: "Due Now",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          }
        ]
      };

      // Initial check
      let dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(1);
      expect(dueCards[0].frontText).toBe("Due Now");

      // Advance 29 days
      mockDate = new Date(mockDate.getTime() + 29 * 24 * 60 * 60 * 1000);
      dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(1);
      expect(dueCards[0].frontText).toBe("Due Now");

      // Advance to exactly when the card is due
      mockDate = new Date(futureDate.getTime());
      dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(2);
      expect(dueCards.map(c => c.frontText)).toEqual(["Due Now", "Far Future"]);
    });

    test('handles edge cases', () => {
      const deck = {
        cards: [
          // Edge case: undefined dates
          {
            frontText: "Bad Data 1",
            lastReviewed: mockDate.toISOString(),
            nextReview: undefined
          },
          // Edge case: invalid date string
          {
            frontText: "Bad Data 2",
            lastReviewed: mockDate.toISOString(),
            nextReview: "invalid-date"
          },
          // Edge case: null dates
          {
            frontText: "Bad Data 3",
            lastReviewed: null,
            nextReview: null
          },
          // Valid card for comparison
          {
            frontText: "Good Data",
            lastReviewed: mockDate.toISOString(),
            nextReview: mockDate.toISOString()
          }
        ]
      };

      const dueCards = getDueCards(deck, 10, 0);
      expect(dueCards).toHaveLength(2); // Bad Data 3 (treated as new) + Good Data
      expect(dueCards.map(c => c.frontText)).toEqual(["Bad Data 3", "Good Data"]);
    });
  });

  describe('Time Advancement Simulation', () => {
    test('simulates advancing multiple days', () => {
      const card = {
        interval: 1,
        repetitions: 0,
        easeFactor: 2.5,
        lastReviewed: null,
        nextReview: null
      };

      // Day 1: First review
      let result = updateCardScheduling(card, 'correct');
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(1);

      // Advance to next day
      mockDate = new Date('2024-01-02T12:00:00Z');
      
      // Day 2: Second review
      result = updateCardScheduling(result, 'correct');
      expect(result.interval).toBe(6);
      expect(result.repetitions).toBe(2);

      // Advance 6 days
      mockDate = new Date('2024-01-08T12:00:00Z');
      
      // Day 8: Third review
      result = updateCardScheduling(result, 'correct');
      expect(result.interval).toBe(15);
      expect(result.repetitions).toBe(3);
    });

    test('simulates skipping review days', () => {
      const card = {
        interval: 1,
        repetitions: 0,
        easeFactor: 2.5,
        lastReviewed: null,
        nextReview: null
      };

      // Day 1: First review
      let result = updateCardScheduling(card, 'correct');
      expect(result.interval).toBe(1);
      expect(result.repetitions).toBe(1);

      // Skip a few days
      mockDate = new Date('2024-01-05T12:00:00Z');
      
      // Day 5: Late review
      result = updateCardScheduling(result, 'correct');
      // interval * (1 + 0.2 * daysLate) = 6 * 1.6 = 10 (rounded)
      expect(result.interval).toBe(10);
      expect(result.repetitions).toBe(2);
    });
  });
}); 