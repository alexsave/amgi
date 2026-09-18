import { CardScheduler } from '../../utils/cardscheduler';

const NOW = new Date('2024-01-01T12:00:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

const card = (id, front = `front ${id}`, back = `back ${id}`) =>
  ({ id, front_text: front, back_text: back });

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

  describe('learn-ahead limit', () => {
    test('a learning card whose step is nearly up is served when nothing else is left', () => {
      scheduler.setReviewTime(card('learning1'), NOW.getTime() + 10 * 60 * 1000, 'learning');

      expect(scheduler.peekNext()).toBe('learning1');
    });

    test('a learning card well short of its step is not served early', () => {
      // It used to come straight back, which made the step meaningless
      scheduler.setReviewTime(card('learning1'), NOW.getTime() + 60 * 60 * 1000, 'learning');

      expect(scheduler.peekNext()).toBeNull();
      expect(scheduler.popNext()).toBeNull();
      expect(scheduler.getLearningCardsCount()).toBe(1);
    });

    test('the learn-ahead card still comes last', () => {
      scheduler.setReviewTime(card('learning1'), NOW.getTime() + 10 * 60 * 1000, 'learning');
      scheduler.setReviewTime(card('review1'), NOW.getTime() + 3600000, 'review');

      expect(scheduler.popNext().id).toBe('review1');
      expect(scheduler.popNext().id).toBe('learning1');
    });
  });

  describe('daily new-card budget', () => {
    test('new cards beyond the budget are not served or counted', () => {
      scheduler.setNewCardBudget(1);
      scheduler.pushNewCard(card('new1'));
      scheduler.pushNewCard(card('new2'));

      expect(scheduler.getNewCardsCount()).toBe(1);

      scheduler.recordAnswer('new1');
      scheduler.delete('new1');

      expect(scheduler.getNewCardsCount()).toBe(0);
      expect(scheduler.peekNext()).toBeNull();
    });

    test('an exhausted budget still lets due cards through', () => {
      scheduler.setNewCardBudget(0);
      scheduler.pushNewCard(card('new1'));
      scheduler.setReviewTime(card('review1'), NOW.getTime(), 'review');

      expect(scheduler.popNext().id).toBe('review1');
      expect(scheduler.popNext()).toBeNull();
    });

    test('only new cards spend the budget', () => {
      scheduler.setNewCardBudget(1);
      scheduler.setReviewTime(card('review1'), NOW.getTime(), 'review');
      scheduler.pushNewCard(card('new1'));

      scheduler.recordAnswer('review1');
      expect(scheduler.newCardsRemaining).toBe(1);

      scheduler.recordAnswer('new1');
      expect(scheduler.newCardsRemaining).toBe(0);
    });

    test('without a budget the scheduler serves every new card', () => {
      scheduler.pushNewCard(card('new1'));
      scheduler.pushNewCard(card('new2'));

      scheduler.recordAnswer('new1');
      scheduler.delete('new1');

      expect(scheduler.getNewCardsCount()).toBe(1);
      expect(scheduler.peekNext()).toBe('new2');
    });

    test('clear resets the budget', () => {
      scheduler.setNewCardBudget(0);
      scheduler.clear();
      scheduler.pushNewCard(card('new1'));

      expect(scheduler.peekNext()).toBe('new1');
    });
  });

  describe('sibling burying', () => {
    // The two directions of one translation pair share text and audio
    const forward = () => card('forward', 'Thank you', 'Gomawo');
    const reverse = () => card('reverse', 'Gomawo', 'Thank you');

    test('answering one direction buries the other', () => {
      scheduler.pushNewCard(forward());
      scheduler.pushNewCard(reverse());
      scheduler.pushNewCard(card('unrelated'));

      expect(scheduler.recordAnswer('forward')).toEqual(['reverse']);
      scheduler.delete('forward');

      // The reverse card would just echo the answer that was on screen
      expect(scheduler.peekNext()).toBe('unrelated');
    });

    test('a buried sibling is served rather than ending the session early', () => {
      scheduler.pushNewCard(forward());
      scheduler.pushNewCard(reverse());

      scheduler.recordAnswer('forward');
      scheduler.delete('forward');

      expect(scheduler.peekNext()).toBe('reverse');
    });

    test('burying survives the card being rescheduled', () => {
      scheduler.pushNewCard(forward());
      scheduler.pushNewCard(reverse());
      scheduler.pushNewCard(card('unrelated'));

      scheduler.recordAnswer('reverse');
      scheduler.delete('reverse');
      // The answered card comes back on a learning step
      scheduler.setReviewTime(reverse(), NOW.getTime() - 1, 'learning');

      expect(scheduler.isBuried('forward')).toBe(true);
      expect(scheduler.popNext().id).toBe('reverse');
      expect(scheduler.popNext().id).toBe('unrelated');
      expect(scheduler.popNext().id).toBe('forward');
    });

    test('cards that merely share one side are not siblings', () => {
      scheduler.pushNewCard(card('a', 'Thank you', 'Gomawo'));
      scheduler.pushNewCard(card('b', 'Thank you', 'Kamsahamnida'));

      expect(scheduler.recordAnswer('a')).toEqual([]);
      scheduler.delete('a');
      expect(scheduler.peekNext()).toBe('b');
    });

    test('answering an unknown card buries nothing', () => {
      expect(scheduler.recordAnswer('missing')).toEqual([]);
    });
  });
});
