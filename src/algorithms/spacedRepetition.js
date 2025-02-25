// Spaced repetition algorithm implementation

export function calculateNextReview(review, quality) {
  // Initialize values from review or use defaults
  let interval = review?.interval_days || 1;
  let easeFactor = review?.ease_factor || 2.5;
  let repetitions = review?.repetitions || 0;
  const currentState = review?.card_state || 'new';

  let nextReview;

  if (quality === 'correct') {
    // Calculate next review date first
    const now = new Date();

    if (currentState === 'new') {
      // New steps: 10 minutes
      nextReview = new Date(now.getTime() + 10 * 60 * 1000);
    } else {
      // Review and learning
      nextReview = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

      if (repetitions <= 1) {
        interval = 1;
      } else {
        // Calculate new interval with graduated intervals
        interval = Math.round(interval * easeFactor);
        // Cap at 10 years
        interval = Math.min(interval, 365 * 10);
      }
    }

    // Increment repetitions
    repetitions += 1;

  } else {
    // Incorrect response
    const now = new Date();

    // Always go back to learning state with 10 minute delay
    nextReview = new Date(now.getTime() + 10 * 60 * 1000);

    // Reset interval 
    interval = 1;

    // Only decrease ease if it was a review card
    if (currentState === 'review') {
      easeFactor -= 0.2; // 20 percentage point decrease, minimum 130%
    }
  }
  // Ensure minimum ease of 130%
  easeFactor = Math.max(1.3, easeFactor);

  return {
    interval,
    easeFactor,
    repetitions,
    nextReview: nextReview.toISOString()
  };
}

export function getDueCards(deck, maxNewCards, newCardsToday) {
  if (!deck || !deck.cards) return [];

  const now = new Date();

  // Separate new and review cards
  const newCards = deck.cards.filter(card => !card.lastReviewed);
  const reviewCards = deck.cards.filter(card => {
    if (!card.lastReviewed) return false;

    // If the card has a due timestamp (for cards due in minutes), check against that
    if (card.dueTimestamp) {
      return new Date(card.dueTimestamp) <= now;
    }

    // Check against next review timestamp
    if (!card.nextReview) return false;
    return new Date(card.nextReview) <= now;
  });

  // Sort review cards by due date/timestamp
  const sortedReviewCards = [...reviewCards].sort((a, b) => {
    const aTime = a.dueTimestamp ? new Date(a.dueTimestamp) : new Date(a.nextReview);
    const bTime = b.dueTimestamp ? new Date(b.dueTimestamp) : new Date(b.nextReview);
    return aTime - bTime;
  });

  // Calculate how many new cards we can show
  const remainingNewCards = Math.max(0, maxNewCards - newCardsToday);
  const limitedNewCards = newCards.slice(0, remainingNewCards);

  // Return new cards first (limited by max), then review cards
  return [...limitedNewCards, ...sortedReviewCards];
}
