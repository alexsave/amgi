import { CardScheduler } from '../../utils/cardscheduler';

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
});

afterEach(() => {
  jest.clearAllMocks();
  global.Date = RealDate;
});

afterAll(() => {
  jest.useRealTimers();
});

describe('CardScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new CardScheduler();
  });

  describe('Basic Operations', () => {
    test('starts empty', () => {
      expect(scheduler.getTotalCardsCount()).toBe(0);
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(0);
      expect(scheduler.peekNext()).toBeNull();
    });

    test('can add and remove new cards', () => {
      scheduler.pushNewCard('card1');
      scheduler.pushNewCard('card2');
      
      expect(scheduler.getNewCardsCount()).toBe(2);
      expect(scheduler.peekNext()).toBe('card1');
      
      expect(scheduler.popNext()).toBe('card1');
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.peekNext()).toBe('card2');
    });

    test('can delete cards from any queue', () => {
      scheduler.pushNewCard('new1');
      scheduler.setReviewTime('learning1', mockDate.getTime() + 600000, 'learning');
      scheduler.setReviewTime('review1', mockDate.getTime() + 86400000, 'review');

      expect(scheduler.getTotalCardsCount()).toBe(3);
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      expect(scheduler.getReviewCardsCount()).toBe(1);

      scheduler.delete('new1');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      expect(scheduler.getReviewCardsCount()).toBe(1);

      scheduler.delete('learning1');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(1);

      scheduler.delete('review1');
      expect(scheduler.getTotalCardsCount()).toBe(0);
    });

    test('clear removes all cards', () => {
      scheduler.pushNewCard('new1');
      scheduler.setReviewTime('learning1', mockDate.getTime() + 600000, 'learning');
      scheduler.setReviewTime('review1', mockDate.getTime() + 86400000, 'review');

      expect(scheduler.getTotalCardsCount()).toBe(3);
      scheduler.clear();
      expect(scheduler.getTotalCardsCount()).toBe(0);
    });
  });

  describe('Card State Transitions', () => {
    test('can move cards between states', () => {
      // Add as new card
      scheduler.pushNewCard('card1');
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(0);

      // Move to learning
      scheduler.setReviewTime('card1', mockDate.getTime() + 600000, 'learning');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      expect(scheduler.getReviewCardsCount()).toBe(0);

      // Move to review
      scheduler.setReviewTime('card1', mockDate.getTime() + 86400000, 'review');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(1);
    });

    test('updates review time for existing cards', () => {
      // Set card to be due in 10 minutes
      scheduler.setReviewTime('card1', mockDate.getTime() + 600000, 'learning');
      expect(scheduler.peekNext()).toBe('card1'); // Now due

      // Set card to be due 1ms ago
      scheduler.setReviewTime('card1', mockDate.getTime() - 1, 'learning');
      expect(scheduler.peekNext()).toBe('card1'); // Now due

      // Set card to be due in 20 minutes
      scheduler.setReviewTime('card1', mockDate.getTime() + 1200000, 'learning');
      expect(scheduler.peekNext()).toBe('card1'); // Now due
    });
  });

  describe('Card Scheduling Priority', () => {
    test('prioritizes learning cards due now over new cards', () => {
      scheduler.pushNewCard('new1');
      scheduler.setReviewTime('learning1', mockDate.getTime() - 1, 'learning'); // Due 1ms ago

      expect(scheduler.popNext()).toBe('learning1');
      expect(scheduler.popNext()).toBe('new1');
    });

    test('prioritizes new cards over review cards due today', () => {
      scheduler.pushNewCard('new1');
      scheduler.setReviewTime('review1', mockDate.getTime() + 3600000, 'review');

      expect(scheduler.popNext()).toBe('new1');
      expect(scheduler.popNext()).toBe('review1');
    });

    test('prioritizes learning cards by due time', () => {
      scheduler.setReviewTime('learning1', mockDate.getTime() + 600000, 'learning');
      scheduler.setReviewTime('learning2', mockDate.getTime() - 1, 'learning'); // Due 1ms ago

      expect(scheduler.popNext()).toBe('learning2'); // Due now
      
      // Advance time past first card's due time
      mockDate = new Date(mockDate.getTime() + 601000);
      expect(scheduler.popNext()).toBe('learning1');
    });

    test('prioritizes review cards by due time', () => {
      scheduler.setReviewTime('review1', mockDate.getTime() + 7200000, 'review');
      scheduler.setReviewTime('review2', mockDate.getTime() + 3600000, 'review');

      expect(scheduler.popNext()).toBe('review2'); // Due sooner
      expect(scheduler.popNext()).toBe('review1');
    });
  });

  describe('Edge Cases', () => {
    test('handles empty queues gracefully', () => {
      expect(scheduler.popNext()).toBeNull();
      expect(scheduler.peekNext()).toBeNull();
      expect(() => scheduler.delete('nonexistent')).not.toThrow();
    });

    test('handles moving non-existent cards', () => {
      expect(() => scheduler.setReviewTime('nonexistent', mockDate.getTime(), 'learning')).not.toThrow();
    });

    test('handles invalid card states', () => {
      scheduler.setReviewTime('card1', mockDate.getTime(), 'invalid');
      expect(scheduler.getTotalCardsCount()).toBe(0);
    });

    test('maintains correct counts after operations', () => {
      scheduler.pushNewCard('new1');
      scheduler.pushNewCard('new2');
      scheduler.setReviewTime('learning1', mockDate.getTime() - 1, 'learning'); // Due 1ms ago
      scheduler.setReviewTime('review1', mockDate.getTime() - 1, 'review'); // Due 1ms ago

      expect(scheduler.getTotalCardsCount()).toBe(4);

      scheduler.popNext();
      scheduler.popNext();

      // Counts should reflect removed cards
      expect(scheduler.getTotalCardsCount()).toBe(2);
    });

    test('properly moves new card to learning state', () => {
      scheduler.pushNewCard('new1');
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.getLearningCardsCount()).toBe(0);

      // Set the card to learning state with a 10 minute delay
      const nextReviewTime = mockDate.getTime() + 10 * 60 * 1000;
      scheduler.setReviewTime('new1', nextReviewTime, 'learning');

      // Verify the card was removed from new queue and added to learning heap
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);

      // Verify the card is still in the scheduler
      expect(scheduler.getTotalCardsCount()).toBe(1);

      // Verify we can find it in the learning heap
      const learningHeapContents = scheduler.learningHeap.heap;
      expect(learningHeapContents).toHaveLength(1);
      expect(learningHeapContents[0].id).toBe('new1');
      expect(learningHeapContents[0].nextReviewTime).toBe(nextReviewTime);
    });

    test('maintains card state through peek and pop operations', () => {
      scheduler.pushNewCard('new1');
      
      // Verify initial state
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.peekNext()).toBe('new1');
      
      // Move to learning
      const nextReviewTime = mockDate.getTime() + 10 * 60 * 1000;
      scheduler.setReviewTime('new1', nextReviewTime, 'learning');
      
      // Verify after setReviewTime
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      
      // Verify peek shows learning card
      const peekedId = scheduler.peekNext();
      expect(peekedId).toBe('new1');
      
      // Verify state hasn't changed after peek
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      
      // Pop the card and verify state
      const poppedId = scheduler.popNext();
      expect(poppedId).toBe('new1');
      expect(scheduler.getLearningCardsCount()).toBe(0);
    });

    test('handles multiple state transitions correctly', () => {
      // Add two cards
      scheduler.pushNewCard('card1');
      scheduler.pushNewCard('card2');
      expect(scheduler.getNewCardsCount()).toBe(2);
      
      // Move first card to learning
      scheduler.setReviewTime('card1', mockDate.getTime() + 600000, 'learning');
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      
      // Verify card1 is still in learning after peeking
      expect(scheduler.peekNext()).toBe('card2');
      expect(scheduler.getLearningCardsCount()).toBe(1);
      
      // Move second card to learning
      scheduler.setReviewTime('card2', mockDate.getTime() + 300000, 'learning');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(2);
      
      // Verify card2 is now first (due sooner)
      expect(scheduler.peekNext()).toBe('card2');
      
      // Pop card2 and verify card1 remains
      scheduler.popNext();
      expect(scheduler.getLearningCardsCount()).toBe(1);
      expect(scheduler.peekNext()).toBe('card1');
    });

    test('verifies internal queue/heap state after transitions', () => {
      scheduler.pushNewCard('card1');
      
      // Verify card is only in new queue
      expect(scheduler.newQueue.items).toContain('card1');
      expect(scheduler.learningHeap.heap).toHaveLength(0);
      expect(scheduler.reviewHeap.heap).toHaveLength(0);
      
      // Move to learning
      scheduler.setReviewTime('card1', mockDate.getTime() + 600000, 'learning');
      
      // Verify card is completely removed from new queue
      expect(scheduler.newQueue.items).not.toContain('card1');
      expect(scheduler.newQueue.items).toHaveLength(0);
      
      // Verify card is properly in learning heap
      expect(scheduler.learningHeap.heap).toHaveLength(1);
      expect(scheduler.learningHeap.heap[0].id).toBe('card1');
      
      // Verify card is not in review heap
      expect(scheduler.reviewHeap.heap).toHaveLength(0);
    });
  });
}); 