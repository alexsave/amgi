import {
  calculateNextReview,
  processCardReview,
  buildReviewLog,
  fuzzInterval,
  isLeech,
  DEFAULT_EASE_FACTOR,
  EASE_BONUS_ON_GOOD,
  GRADUATING_INTERVAL_DAYS,
  LEARNING_STEPS_MINUTES,
  LEECH_THRESHOLD,
  MAX_EASE_FACTOR,
  MIN_EASE_FACTOR,
  RATINGS
} from '../../algorithms/spacedRepetition';

// Freeze time so next_review_date assertions are deterministic
const NOW = new Date('2024-01-01T12:00:00Z');

// Fuzz is injected everywhere so intervals are exact; 0.5 is the midpoint of
// the spread, which means no movement.
const NO_FUZZ = { random: () => 0.5 };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

const minutesFromNow = (mins) => new Date(NOW.getTime() + mins * 60 * 1000).toISOString();
const daysFromNow = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

describe('learning steps', () => {
  test('the ladder is a single ordered constant', () => {
    expect(LEARNING_STEPS_MINUTES).toEqual([1, 10]);
  });

  // A card's whole life, one row per answer. Each row asserts the state the
  // card is in after the grade in that row.
  const life = [
    {
      what: 'new card, Good: enters learning on the second step, as in Anki',
      quality: 'correct',
      expected: {
        card_state: 'learning',
        learning_step: 1,
        interval_days: 1,
        repetitions: 1,
        lapses: 0,
        ease_factor: 2.5,
        next_review_date: minutesFromNow(10)
      }
    },
    {
      what: 'last learning step, Good: graduates at the graduating interval',
      quality: 'correct',
      expected: {
        card_state: 'review',
        learning_step: 0,
        interval_days: GRADUATING_INTERVAL_DAYS,
        repetitions: 2,
        lapses: 0,
        ease_factor: 2.5,
        next_review_date: daysFromNow(1)
      }
    },
    {
      what: 'review card, Good: interval grows by ease',
      quality: 'correct',
      expected: {
        card_state: 'review',
        learning_step: 0,
        interval_days: 3, // round(1 * 2.5)
        repetitions: 3,
        lapses: 0,
        ease_factor: 2.5, // already at the cap
        next_review_date: daysFromNow(3)
      }
    },
    {
      what: 'review card, Again: lapses, loses ease, relearns from the first step',
      quality: 'incorrect',
      expected: {
        card_state: 'learning',
        learning_step: 0,
        interval_days: 1,
        repetitions: 3,
        lapses: 1,
        ease_factor: 2.3,
        next_review_date: minutesFromNow(1)
      }
    },
    {
      what: 'relearning, Good: back up the same ladder',
      quality: 'correct',
      expected: {
        card_state: 'learning',
        learning_step: 1,
        interval_days: 1,
        repetitions: 4,
        lapses: 1,
        ease_factor: 2.3,
        next_review_date: minutesFromNow(10)
      }
    },
    {
      what: 'relearning, Good again: re-graduates',
      quality: 'correct',
      expected: {
        card_state: 'review',
        learning_step: 0,
        interval_days: 1,
        repetitions: 5,
        lapses: 1,
        ease_factor: 2.3,
        next_review_date: daysFromNow(1)
      }
    },
    {
      what: 'review card, Good: ease starts recovering',
      quality: 'correct',
      expected: {
        card_state: 'review',
        learning_step: 0,
        interval_days: 2, // round(1 * 2.3)
        repetitions: 6,
        lapses: 1,
        ease_factor: 2.35,
        next_review_date: daysFromNow(2)
      }
    }
  ];

  test('a card walks new -> learning -> review -> lapse -> recovery', () => {
    let review = null;

    for (const step of life) {
      review = calculateNextReview(review, step.quality, NO_FUZZ);
      expect({ what: step.what, ...review }).toEqual({ what: step.what, ...step.expected });
    }
  });

  test('Again on a new card puts it on the first step, not the second', () => {
    const result = calculateNextReview(null, 'incorrect', NO_FUZZ);

    expect(result.card_state).toBe('learning');
    expect(result.learning_step).toBe(0);
    expect(result.next_review_date).toBe(minutesFromNow(1));
  });

  test('Again on a card halfway up the ladder sends it back to the first step', () => {
    const review = {
      card_state: 'learning',
      learning_step: 1,
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5
    };

    const result = calculateNextReview(review, 'incorrect', NO_FUZZ);

    expect(result.learning_step).toBe(0);
    expect(result.next_review_date).toBe(minutesFromNow(1));
  });

  test('the ladder is injectable, so a longer one graduates later', () => {
    const learningSteps = [1, 10, 60];
    const afterFirst = calculateNextReview(null, 'correct', { ...NO_FUZZ, learningSteps });
    const afterSecond = calculateNextReview(afterFirst, 'correct', { ...NO_FUZZ, learningSteps });
    const afterThird = calculateNextReview(afterSecond, 'correct', { ...NO_FUZZ, learningSteps });

    expect(afterFirst.next_review_date).toBe(minutesFromNow(10));
    expect(afterSecond.next_review_date).toBe(minutesFromNow(60));
    expect(afterSecond.card_state).toBe('learning');
    expect(afterThird.card_state).toBe('review');
  });
});

describe('ease factor', () => {
  const reviewCard = (ease) => ({
    interval_days: 10,
    repetitions: 5,
    ease_factor: ease,
    card_state: 'review'
  });

  test('a correct answer on a review card raises ease', () => {
    const result = calculateNextReview(reviewCard(2.0), 'correct', NO_FUZZ);

    expect(result.ease_factor).toBe(2.0 + EASE_BONUS_ON_GOOD);
  });

  test('ease never rises above the starting value', () => {
    const result = calculateNextReview(reviewCard(MAX_EASE_FACTOR), 'correct', NO_FUZZ);

    expect(result.ease_factor).toBe(MAX_EASE_FACTOR);
  });

  test('ease never drops below the floor', () => {
    const result = calculateNextReview(reviewCard(1.4), 'incorrect', NO_FUZZ);

    expect(result.ease_factor).toBe(MIN_EASE_FACTOR);
  });

  test('a card at the floor can climb all the way back to the default', () => {
    let review = {
      interval_days: 1,
      repetitions: 5,
      ease_factor: MIN_EASE_FACTOR,
      card_state: 'review'
    };

    // Ease hell used to be permanent: nothing in the scheduler ever raised it.
    for (let i = 0; i < 100; i++) {
      review = calculateNextReview({ ...review, card_state: 'review' }, 'correct', NO_FUZZ);
    }

    expect(review.ease_factor).toBe(DEFAULT_EASE_FACTOR);
  });

  test('learning cards do not move ease in either direction', () => {
    const learning = {
      interval_days: 1,
      repetitions: 1,
      ease_factor: 2.5,
      card_state: 'learning',
      learning_step: 0
    };

    expect(calculateNextReview(learning, 'incorrect', NO_FUZZ).ease_factor).toBe(2.5);
    expect(calculateNextReview(learning, 'correct', NO_FUZZ).ease_factor).toBe(2.5);
  });

  test('ease stays clean to two decimals over a long history', () => {
    let review = {
      interval_days: 1,
      repetitions: 5,
      ease_factor: 1.35,
      card_state: 'review'
    };

    for (let i = 0; i < 5; i++) {
      review = calculateNextReview({ ...review, card_state: 'review' }, 'correct', NO_FUZZ);
    }

    expect(review.ease_factor).toBe(1.6);
  });
});

describe('interval fuzz', () => {
  test.each([
    ['one day has nowhere to move', 1, 0, 1],
    ['one day has nowhere to move, high roll', 1, 1, 1],
    ['two days, low roll', 2, 0, 2],
    ['two days, midpoint roll', 2, 0.5, 2],
    ['two days, high roll', 2, 1, 3],
    ['ten days, low roll', 10, 0, 9],
    ['ten days, high roll', 10, 1, 11],
    ['a hundred days spreads by five', 100, 0, 95],
    ['a hundred days spreads by five, high roll', 100, 1, 105]
  ])('%s', (_what, interval, roll, expected) => {
    expect(fuzzInterval(interval, () => roll)).toBe(expected);
  });

  test('a fuzzed interval stays within a few percent of the unfuzzed one', () => {
    for (let roll = 0; roll <= 1; roll += 0.05) {
      const fuzzed = fuzzInterval(200, () => roll);
      expect(fuzzed).toBeGreaterThanOrEqual(190);
      expect(fuzzed).toBeLessThanOrEqual(210);
    }
  });

  test('cards due on the same day with the same history drift apart', () => {
    const review = {
      interval_days: 30,
      repetitions: 5,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const low = calculateNextReview(review, 'correct', { random: () => 0 });
    const high = calculateNextReview(review, 'correct', { random: () => 1 });

    expect(low.interval_days).toBeLessThan(high.interval_days);
  });

  test('the scheduler fuzzes by default, without an injected source', () => {
    const review = {
      interval_days: 100,
      repetitions: 5,
      ease_factor: 2.5,
      card_state: 'review'
    };

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(calculateNextReview(review, 'correct').interval_days).toBe(237); // 250 - 13
    } finally {
      spy.mockRestore();
    }
  });

  test('graduating intervals are short enough to be left alone', () => {
    const result = calculateNextReview(
      { card_state: 'learning', learning_step: 1, interval_days: 1, repetitions: 1, ease_factor: 2.5 },
      'correct',
      { random: () => 1 }
    );

    expect(result.interval_days).toBe(GRADUATING_INTERVAL_DAYS);
  });
});

describe('lapses and leeches', () => {
  test('lapses accumulate on review cards only', () => {
    let review = {
      interval_days: 10,
      repetitions: 5,
      ease_factor: 2.5,
      lapses: 0,
      card_state: 'review'
    };

    review = calculateNextReview(review, 'incorrect', NO_FUZZ);
    expect(review.lapses).toBe(1);

    // Failing again while relearning is not a second lapse
    review = calculateNextReview(review, 'incorrect', NO_FUZZ);
    expect(review.lapses).toBe(1);
  });

  test('a card that keeps failing crosses the leech threshold', () => {
    let review = { interval_days: 10, repetitions: 5, ease_factor: 2.5, lapses: 0, card_state: 'review' };

    for (let i = 0; i < LEECH_THRESHOLD; i++) {
      review = calculateNextReview({ ...review, card_state: 'review' }, 'incorrect', NO_FUZZ);
    }

    expect(review.lapses).toBe(LEECH_THRESHOLD);
    expect(isLeech(review)).toBe(true);
  });

  test('a card below the threshold is not a leech', () => {
    expect(isLeech({ lapses: LEECH_THRESHOLD - 1 })).toBe(false);
    expect(isLeech(null)).toBe(false);
  });

  test('the count survives a correct answer', () => {
    const result = calculateNextReview(
      { interval_days: 10, repetitions: 5, ease_factor: 2.5, lapses: 3, card_state: 'review' },
      'correct',
      NO_FUZZ
    );

    expect(result.lapses).toBe(3);
  });
});

describe('buildReviewLog', () => {
  test('captures the state as it was before the answer', () => {
    const previous = {
      card_state: 'review',
      interval_days: 12,
      ease_factor: 2.3,
      repetitions: 7,
      last_reviewed_at: new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString()
    };

    expect(buildReviewLog(previous, RATINGS.GOOD)).toEqual({
      reviewed_at: NOW.toISOString(),
      rating: 'good',
      card_state: 'review',
      interval_days: 12,
      ease_factor: 2.3,
      repetitions: 7,
      // Answered three days late, which is the signal the schedule throws away
      elapsed_days: 15,
      scheduled_days: 12
    });
  });

  test('a card that has never been reviewed has no elapsed time', () => {
    expect(buildReviewLog(null, RATINGS.AGAIN)).toEqual({
      reviewed_at: NOW.toISOString(),
      rating: 'again',
      card_state: 'new',
      interval_days: 0,
      ease_factor: DEFAULT_EASE_FACTOR,
      repetitions: 0,
      elapsed_days: null,
      scheduled_days: 0
    });
  });

  test('sub-day learning steps round down to zero elapsed days', () => {
    const previous = {
      card_state: 'learning',
      interval_days: 1,
      ease_factor: 2.5,
      repetitions: 1,
      last_reviewed_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString()
    };

    const log = buildReviewLog(previous, RATINGS.GOOD);

    expect(log.elapsed_days).toBe(0);
    expect(log.scheduled_days).toBe(0);
  });
});

describe('processCardReview', () => {
  const newCard = () => ({ review: { interval_days: 1, ease_factor: 2.5, repetitions: 0, card_state: 'new' } });
  const reviewCard = () => ({ review: { interval_days: 5, ease_factor: 2.5, repetitions: 3, card_state: 'review' } });

  test('scheduling fields and control flags come back separately', () => {
    const { review, control } = processCardReview(newCard(), 'correct', 0, 3, NO_FUZZ);

    // Nothing that only the session cares about may leak into what is persisted
    expect(Object.keys(review).sort()).toEqual([
      'card_state',
      'ease_factor',
      'interval_days',
      'lapses',
      'learning_step',
      'next_review_date',
      'repetitions'
    ]);
    expect(Object.keys(control).sort()).toEqual([
      'resetAttempts',
      'shouldGoToNextCard',
      'shouldReschedule'
    ]);
  });

  test('correct on first attempt advances and resets attempts', () => {
    const { review, control } = processCardReview(newCard(), 'correct', 0, 3, NO_FUZZ);

    expect(control.shouldGoToNextCard).toBe(true);
    expect(control.resetAttempts).toBe(true);
    expect(review.card_state).toBe('learning');
  });

  test('correct after failed attempts is treated as a lapse', () => {
    const { review, control } = processCardReview(reviewCard(), 'correct', 2, 3, NO_FUZZ);

    // Got there eventually, but it still goes back to learning
    expect(control.shouldGoToNextCard).toBe(true);
    expect(review.card_state).toBe('learning');
    expect(review.lapses).toBe(1);
  });

  test('incorrect with attempts remaining keeps the same card and schedules nothing', () => {
    const { review, control } = processCardReview(newCard(), 'incorrect', 0, 3, NO_FUZZ);

    expect(control.shouldGoToNextCard).toBe(false);
    expect(control.resetAttempts).toBe(false);
    expect(control.shouldReschedule).toBe(false);
    // Review data is untouched while retries remain
    expect(review.card_state).toBe('new');
  });

  test('incorrect at max attempts reschedules and moves on', () => {
    const { review, control } = processCardReview(newCard(), 'incorrect', 2, 3, NO_FUZZ);

    expect(control.shouldGoToNextCard).toBe(true);
    expect(control.resetAttempts).toBe(true);
    expect(control.shouldReschedule).toBe(true);
    expect(review.card_state).toBe('learning');
  });

  test('a card that reaches review is done for the session', () => {
    const { review, control } = processCardReview(reviewCard(), 'correct', 0, 3, NO_FUZZ);

    expect(review.card_state).toBe('review');
    expect(control.shouldReschedule).toBe(false);
  });
});
