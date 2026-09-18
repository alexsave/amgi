// Spaced repetition: a binary-graded SM-2 variant.
//
// amgi's review loop is hands-free, so the reviewer only ever answers Good or
// Again. Every signal Anki would take from Hard/Easy has to be carried by
// those two buttons, which is why Good moves ease here where Anki's Good
// leaves it alone.

export const DEFAULT_EASE_FACTOR = 2.5;
export const MIN_EASE_FACTOR = 1.3;
// Without an Easy button nothing ever proves a card is easier than the
// default, so ease recovers towards the starting value but never past it.
// That makes ease purely a penalty with a way back out, which is the whole
// point: before this, ease could only fall.
export const MAX_EASE_FACTOR = DEFAULT_EASE_FACTOR;
// SM-2 moves ease by +0.1 for a perfect recall and by 0 for a hesitant one. A
// binary Good sits between the two, so it earns half the perfect bonus: four
// clean reviews undo one lapse, which is slow enough that a genuinely hard
// card stays hard.
export const EASE_BONUS_ON_GOOD = 0.05;
export const EASE_PENALTY_ON_LAPSE = 0.2;

// Anki's default learning steps, in minutes. Again drops the card back to the
// first step, Good advances one, and Good past the last step graduates the
// card. Relearning reuses the same ladder instead of a second configurable
// list, because there is no per-deck options UI to configure either one.
export const LEARNING_STEPS_MINUTES = [1, 10];
export const GRADUATING_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 365 * 10;

// Anki tags a card as a leech at 8 lapses. Nothing acts on this yet; lapses
// are counted so that a future UI can surface or suspend these cards.
export const LEECH_THRESHOLD = 8;

// Anki spreads intervals by a few percent so that cards introduced in the
// same session do not stay clumped together for the life of the deck.
export const FUZZ_RATIO = 0.05;

export const RATINGS = {
  AGAIN: 'again',
  GOOD: 'good'
};

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

// Ease is stored as a float and nudged by hundredths, so round it back to two
// decimals after every move or it accumulates binary-float noise.
const roundEase = (ease) => Math.round(ease * 100) / 100;

const clampEase = (ease) => roundEase(Math.min(MAX_EASE_FACTOR, Math.max(MIN_EASE_FACTOR, ease)));

/**
 * Spread an interval by a few percent so sibling-free cards introduced on the
 * same day drift apart. Intervals under two days have nowhere to move without
 * changing what they mean, so they are left alone.
 *
 * @param {number} intervalDays
 * @param {() => number} random - injected for deterministic tests; 0.5 is no fuzz
 */
export function fuzzInterval(intervalDays, random = Math.random) {
  if (intervalDays < 2) return intervalDays;

  // At least one day of spread, or short intervals could never move at all.
  const spread = Math.max(1, Math.round(intervalDays * FUZZ_RATIO));
  const delta = Math.round((random() * 2 - 1) * spread);

  return Math.max(2, Math.min(MAX_INTERVAL_DAYS, intervalDays + delta));
}

/**
 * A card is a leech once it has been forgotten often enough that drilling it
 * further is a waste of the session.
 */
export function isLeech(review) {
  return (review?.lapses || 0) >= LEECH_THRESHOLD;
}

/**
 * Compute the next scheduling state for a card.
 *
 * Returns only scheduling fields - the shape that is persisted to the reviews
 * row. Control flow for the session lives in processCardReview.
 *
 * @param {Object|null} review - the card's current review row
 * @param {'correct'|'incorrect'} quality
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {() => number} [options.random] - injected randomness for the fuzz
 * @param {number[]} [options.learningSteps] - minutes, ordered
 */
export function calculateNextReview(review, quality, options = {}) {
  const {
    now = new Date(),
    random = Math.random,
    learningSteps = LEARNING_STEPS_MINUTES
  } = options;

  const steps = learningSteps.length > 0 ? learningSteps : LEARNING_STEPS_MINUTES;

  const previous = review || {};
  let interval = previous.interval_days || 1;
  let easeFactor = previous.ease_factor || DEFAULT_EASE_FACTOR;
  let repetitions = previous.repetitions || 0;
  let lapses = previous.lapses || 0;
  let cardState = previous.card_state || 'new';
  let learningStep = previous.learning_step || 0;

  let nextReview;

  if (quality === 'correct') {
    if (cardState === 'review') {
      // SM-2: grow the interval first, then schedule with it. Scheduling with
      // the old interval would lag growth by one review.
      interval = fuzzInterval(
        Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(interval * easeFactor))),
        random
      );
      easeFactor = clampEase(easeFactor + EASE_BONUS_ON_GOOD);
      learningStep = 0;
      nextReview = new Date(now.getTime() + interval * MS_PER_DAY);
    } else {
      // New and learning cards climb the step ladder. A new card sits at step
      // 0 before it is ever answered, so its first Good lands on step 1 - the
      // same as Anki, where Again on a new card gives you the first step.
      const nextStep = learningStep + 1;

      if (nextStep >= steps.length) {
        interval = GRADUATING_INTERVAL_DAYS;
        cardState = 'review';
        learningStep = 0;
        nextReview = new Date(now.getTime() + interval * MS_PER_DAY);
      } else {
        cardState = 'learning';
        learningStep = nextStep;
        nextReview = new Date(now.getTime() + steps[nextStep] * MS_PER_MINUTE);
      }
    }

    repetitions += 1;
  } else {
    // Only a card that had graduated can lapse; failing during the initial
    // acquisition is not evidence about the card, which is why Anki leaves
    // ease alone there too.
    if (cardState === 'review') {
      lapses += 1;
      easeFactor = clampEase(easeFactor - EASE_PENALTY_ON_LAPSE);
    }

    interval = GRADUATING_INTERVAL_DAYS;
    cardState = 'learning';
    learningStep = 0;
    nextReview = new Date(now.getTime() + steps[0] * MS_PER_MINUTE);
  }

  return {
    interval_days: interval,
    ease_factor: clampEase(easeFactor),
    repetitions,
    lapses,
    learning_step: learningStep,
    card_state: cardState,
    next_review_date: nextReview.toISOString()
  };
}

/**
 * Snapshot the state a card was in *before* it was graded, which is what a
 * future FSRS optimiser has to train on. Derived state (the new interval) is
 * deliberately not logged: it is recomputable from this row plus the rating.
 *
 * @param {Object|null} review - the card's review row before the grade
 * @param {'again'|'good'} rating
 * @param {Object} [options]
 * @param {Date} [options.now]
 */
export function buildReviewLog(review, rating, options = {}) {
  const { now = new Date() } = options;

  const previous = review || {};
  const cardState = previous.card_state || 'new';
  const lastReviewedAt = previous.last_reviewed_at ? new Date(previous.last_reviewed_at) : null;

  // Whole days actually waited, and whole days the card was asked to wait.
  // They differ whenever a review is late, which is the signal FSRS uses and
  // this scheduler currently throws away.
  const elapsedDays = lastReviewedAt && !isNaN(lastReviewedAt.getTime())
    ? Math.max(0, Math.floor((now.getTime() - lastReviewedAt.getTime()) / MS_PER_DAY))
    : null;
  const scheduledDays = cardState === 'review' ? (previous.interval_days ?? null) : 0;

  return {
    reviewed_at: now.toISOString(),
    rating,
    card_state: cardState,
    interval_days: previous.interval_days ?? 0,
    ease_factor: previous.ease_factor ?? DEFAULT_EASE_FACTOR,
    repetitions: previous.repetitions ?? 0,
    elapsed_days: elapsedDays,
    scheduled_days: scheduledDays
  };
}

/**
 * Process a card review outcome, considering attempts and current state.
 *
 * The scheduling payload and the session control flags are returned
 * separately: the payload is what gets persisted, the flags never leave the
 * client.
 *
 * @param {Object} card - the card being reviewed
 * @param {'correct'|'incorrect'} outcome
 * @param {number} attempts - failed attempts already made on this card
 * @param {number} maxAttempts - attempts allowed before the card is graded
 * @param {Object} [options] - forwarded to calculateNextReview
 * @returns {{review: Object, control: {shouldReschedule: boolean, resetAttempts: boolean, shouldGoToNextCard: boolean}}}
 */
export function processCardReview(card, outcome, attempts, maxAttempts = 3, options = {}) {
  // Retries left on a miss: the card stays put and nothing is scheduled or
  // logged, because no grade has been given yet.
  if (outcome !== 'correct' && attempts < maxAttempts - 1) {
    return {
      review: {
        interval_days: card.review?.interval_days || 1,
        ease_factor: card.review?.ease_factor || DEFAULT_EASE_FACTOR,
        repetitions: card.review?.repetitions || 0,
        lapses: card.review?.lapses || 0,
        learning_step: card.review?.learning_step || 0,
        card_state: card.review?.card_state || 'new',
        next_review_date: card.review?.next_review_date || new Date().toISOString()
      },
      control: {
        shouldReschedule: false,
        shouldGoToNextCard: false,
        resetAttempts: false
      }
    };
  }

  // A correct answer that took more than one attempt is not recall, so it is
  // graded as a miss. Only the voice conversation mode can reach this.
  const quality = outcome === 'correct' && attempts === 0 ? 'correct' : 'incorrect';
  const review = calculateNextReview(card.review, quality, options);

  return {
    review,
    control: {
      // A card that lands in review is done for the session; anything still
      // on a learning step comes back before the session ends.
      shouldReschedule: review.card_state !== 'review',
      resetAttempts: true,
      shouldGoToNextCard: true
    }
  };
}
