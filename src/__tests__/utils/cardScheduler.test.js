import { CardScheduler } from '../../utils/cardscheduler';

const NOW = new Date('2024-01-01T12:00:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

const card = (id) => ({ id, front_text: `front ${id}`, back_text: `back ${id}` });

describe('CardScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new CardScheduler();
  });

  describe('basic operations', () => {
    test('starts empty', () => {
      expect(scheduler.getTotalCardsCount()).toBe(0);
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(0);
      expect(scheduler.peekNext()).toBeNull();
      expect(scheduler.popNext()).toBeNull();
    });

    test('new cards come out in FIFO order as full cards', () => {
      scheduler.pushNewCard(card('card1'));
      scheduler.pushNewCard(card('card2'));

      expect(scheduler.getNewCardsCount()).toBe(2);
      expect(scheduler.peekNext()).toBe('card1');

      expect(scheduler.popNext().id).toBe('card1');
      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.peekNext()).toBe('card2');
    });

    test('getFullCard returns the stored card', () => {
      const c = card('card1');
      scheduler.pushNewCard(c);
      expect(scheduler.getFullCard('card1')).toBe(c);
      expect(scheduler.getFullCard('missing')).toBeNull();
    });

    test('delete removes cards from any queue', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('learning1'), NOW.getTime() + 600000, 'learning');
      scheduler.setReviewTime(card('review1'), NOW.getTime() + 3600000, 'review');

      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.getLearningCardsCount()).toBe(1);
      expect(scheduler.getReviewCardsCount()).toBe(1);

      expect(scheduler.delete('new1')).toBe(true);
      expect(scheduler.delete('learning1')).toBe(true);
      expect(scheduler.delete('review1')).toBe(true);
      expect(scheduler.delete('nonexistent')).toBe(false);
      expect(scheduler.getTotalCardsCount()).toBe(0);
    });

    test('clear removes everything', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('learning1'), NOW.getTime(), 'learning');
      scheduler.clear();
      expect(scheduler.getTotalCardsCount()).toBe(0);
      expect(scheduler.getFullCard('new1')).toBeNull();
    });
  });

  describe('state transitions', () => {
    test('setReviewTime moves a card between queues', () => {
      const c = card('card1');
      scheduler.pushNewCard(c);
      expect(scheduler.getCardState('card1')).toBe('new');

      scheduler.setReviewTime(c, NOW.getTime() + 600000, 'learning');
      expect(scheduler.getCardState('card1')).toBe('learning');
      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.getLearningCardsCount()).toBe(1);

      scheduler.setReviewTime(c, NOW.getTime() + 86400000, 'review');
      expect(scheduler.getCardState('card1')).toBe('review');
      expect(scheduler.getLearningCardsCount()).toBe(0);
      expect(scheduler.getReviewCardsCount()).toBe(1);

      // Card is never duplicated across queues
      expect(scheduler.getTotalCardsCount()).toBe(1);
    });

    test('setReview parses the ISO date and requeues the card', () => {
      const c = card('card1');
      scheduler.setReview(c, {
        card_state: 'learning',
        next_review_date: new Date(NOW.getTime() + 600000).toISOString()
      });

      expect(scheduler.getCardState('card1')).toBe('learning');
      expect(c.review.card_state).toBe('learning');
      expect(scheduler.learningHeap.peek().nextReviewTime).toBe(NOW.getTime() + 600000);
    });
  });

  describe('scheduling priority', () => {
    test('learning cards due now beat new cards', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('learning1'), NOW.getTime() - 1, 'learning');

      expect(scheduler.popNext().id).toBe('learning1');
      expect(scheduler.popNext().id).toBe('new1');
    });

    test('learning cards due later yield to new cards', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('learning1'), NOW.getTime() + 600000, 'learning');

      expect(scheduler.popNext().id).toBe('new1');
      // Learning card not due yet still comes out last (early review)
      expect(scheduler.popNext().id).toBe('learning1');
    });

    test('new cards beat review cards due today', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('review1'), NOW.getTime() + 3600000, 'review');

      expect(scheduler.popNext().id).toBe('new1');
      expect(scheduler.popNext().id).toBe('review1');
    });

    test('review cards due after today are not served', () => {
      scheduler.setReviewTime(card('review1'), NOW.getTime() + 2 * 86400000, 'review');

      expect(scheduler.peekNext()).toBeNull();
      expect(scheduler.popNext()).toBeNull();
      expect(scheduler.getReviewCardsCount()).toBe(1);
    });

    test('heaps order by due time', () => {
      scheduler.setReviewTime(card('review1'), NOW.getTime() + 7200000, 'review');
      scheduler.setReviewTime(card('review2'), NOW.getTime() + 3600000, 'review');

      expect(scheduler.popNext().id).toBe('review2');
      expect(scheduler.popNext().id).toBe('review1');
    });

    test('peek does not remove the card', () => {
      scheduler.pushNewCard(card('card1'));

      expect(scheduler.peekNext()).toBe('card1');
      expect(scheduler.peekNext()).toBe('card1');
      expect(scheduler.getNewCardsCount()).toBe(1);
    });
  });
});
