import { calculateNextReview, processCardReview } from '../../algorithms/spacedRepetition';

// Freeze time so next_review_date assertions are deterministic
const NOW = new Date('2024-01-01T12:00:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

const minutesFromNow = (mins) => new Date(NOW.getTime() + mins * 60 * 1000).toISOString();
const daysFromNow = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

describe('calculateNextReview', () => {
  test('new card answered correctly enters learning with a 10 minute step', () => {
    const result = calculateNextReview(null, 'correct');

    expect(result.card_state).toBe('learning');
    expect(result.interval_days).toBe(1);
    expect(result.repetitions).toBe(1);
    expect(result.ease_factor).toBe(2.5);
    expect(result.next_review_date).toBe(minutesFromNow(10));
  });

  test('learning card answered correctly graduates to review at 1 day', () => {
    const review = {
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5,
      card_state: 'learning'
    };

    const result = calculateNextReview(review, 'correct');

    expect(result.card_state).toBe('review');
    expect(result.interval_days).toBe(1);
    expect(result.repetitions).toBe(2);
    expect(result.next_review_date).toBe(daysFromNow(1));
  });

  test('review card answered correctly grows interval by ease factor', () => {
    const review = {
      interval_days: 4,
      repetitions: 3,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const result = calculateNextReview(review, 'correct');

    // 4 * 2.5 = 10 days, and the next review is scheduled with the new interval
    expect(result.interval_days).toBe(10);
    expect(result.repetitions).toBe(4);
    expect(result.next_review_date).toBe(daysFromNow(10));
  });

  test('interval is capped at 10 years', () => {
    const review = {
      interval_days: 2000,
      repetitions: 10,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const result = calculateNextReview(review, 'correct');

    expect(result.interval_days).toBe(3650);
  });

  test('incorrect answer sends the card back to learning in 10 minutes', () => {
    const review = {
      interval_days: 5,
      repetitions: 3,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const result = calculateNextReview(review, 'incorrect');

    expect(result.card_state).toBe('learning');
    expect(result.interval_days).toBe(1);
    expect(result.next_review_date).toBe(minutesFromNow(10));
  });

  test('incorrect answer on a review card lowers ease by 0.2', () => {
    const review = {
      interval_days: 5,
      repetitions: 3,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const result = calculateNextReview(review, 'incorrect');

    expect(result.ease_factor).toBeCloseTo(2.3);
  });

  test('incorrect answer on a learning card leaves ease unchanged', () => {
    const review = {
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5,
      card_state: 'learning'
    };

    const result = calculateNextReview(review, 'incorrect');

    expect(result.ease_factor).toBe(2.5);
  });

  test('ease factor never drops below 1.3', () => {
    const review = {
      interval_days: 5,
      repetitions: 3,
      ease_factor: 1.4,
      card_state: 'review'
    };

    const result = calculateNextReview(review, 'incorrect');

    expect(result.ease_factor).toBe(1.3);
  });
});

describe('processCardReview', () => {
  const newCard = { review: { interval_days: 1, ease_factor: 2.5, repetitions: 0, card_state: 'new' } };

  test('correct on first attempt advances and resets attempts', () => {
    const result = processCardReview(newCard, 'correct', 0);

    expect(result.shouldGoToNextCard).toBe(true);
    expect(result.resetAttempts).toBe(true);
    expect(result.card_state).toBe('learning');
  });

  test('correct after failed attempts is treated as a lapse', () => {
    const reviewCard = { review: { interval_days: 5, ease_factor: 2.5, repetitions: 3, card_state: 'review' } };

    const result = processCardReview(reviewCard, 'correct', 2);

    // Got there eventually, but it still goes back to learning
    expect(result.shouldGoToNextCard).toBe(true);
    expect(result.card_state).toBe('learning');
  });

  test('incorrect with attempts remaining keeps the same card', () => {
    const result = processCardReview(newCard, 'incorrect', 0, 3);

    expect(result.shouldGoToNextCard).toBe(false);
    expect(result.resetAttempts).toBe(false);
    // Review data is untouched while retries remain
    expect(result.card_state).toBe('new');
  });

  test('incorrect at max attempts reschedules and moves on', () => {
    const result = processCardReview(newCard, 'incorrect', 2, 3);

    expect(result.shouldGoToNextCard).toBe(true);
    expect(result.resetAttempts).toBe(true);
    expect(result.shouldReschedule).toBe(true);
    expect(result.card_state).toBe('learning');
  });
});
