// Spaced repetition algorithm implementation

export function calculateNextReview(currentInterval, currentEaseFactor, currentRepetitions, quality) {
  let interval = currentInterval;
  let easeFactor = currentEaseFactor;
  let repetitions = currentRepetitions;

  if (quality === 'correct') {
    // Correct response
    if (repetitions === 0) {
      interval = 1; // First interval
    } else if (repetitions === 1) {
      interval = 6; // Second interval
    } else {
      // Calculate new interval
      interval = Math.round(interval * easeFactor);
      // Cap at 10 years
      interval = Math.min(interval, 365 * 10);
    }
    repetitions += 1;
    // Ensure minimum ease of 130%
    easeFactor = Math.max(1.3, easeFactor);
  } else {
    // Incorrect response
    interval = 1;
    repetitions = 0;
    // Only decrease ease if not in learning phase (repetitions > 0)
    if (currentRepetitions > 0) {
      easeFactor = Math.max(1.3, easeFactor - 0.2); // 20 percentage point decrease, minimum 130%
    }
  }

  // Calculate next review date
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + interval);
  const nextReview = nextDate.toISOString();

  return {
    interval,
    easeFactor,
    repetitions,
    nextReview
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

export function updateCardScheduling(card, quality) {
  const now = new Date();
  
  // Initialize or fix any missing/invalid values
  if (typeof card.interval !== 'number' || isNaN(card.interval)) {
    card.interval = 1;
  }
  if (typeof card.repetitions !== 'number' || isNaN(card.repetitions)) {
    card.repetitions = 0;
  }
  if (typeof card.easeFactor !== 'number' || isNaN(card.easeFactor)) {
    card.easeFactor = 2.5; // 250%
  }

  // Calculate late penalty/bonus
  const dueDate = card.nextReview ? new Date(card.nextReview) : now;
  const daysLate = Math.max(0, (now - dueDate) / (1000 * 60 * 60 * 24));
  
  if (quality === 'correct') {
    // Clear any due timestamp since it passed review
    card.dueTimestamp = null;
    
    if (card.repetitions === 0) {
      card.interval = 1; // First interval
    } else if (card.repetitions === 1) {
      card.interval = 6; // Second interval
    } else {
      // Calculate new interval with late bonus
      const newInterval = Math.round(card.interval * card.easeFactor * (1 + 0.2 * daysLate));
      // Cap at 10 years
      card.interval = Math.max(card.interval + 1, Math.min(newInterval, 365 * 10));
    }
    card.repetitions += 1;
    
    // Ensure minimum ease of 130%
    card.easeFactor = Math.max(1.3, card.easeFactor);
  } else {
    // Incorrect response
    // Reset interval and reduce ease
    card.interval = 1;
    card.repetitions = 0;
    
    // Only decrease ease if not in learning phase (repetitions > 0)
    if (card.repetitions > 0) {
      card.easeFactor = Math.max(1.3, card.easeFactor - 0.2); // 20 percentage point decrease, minimum 130%
    }
    
    // Set to be reviewed in 10 minutes
    const dueTime = new Date();
    dueTime.setMinutes(dueTime.getMinutes() + 10);
    card.dueTimestamp = dueTime.toISOString();
  }

  // Calculate next review date
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + card.interval);
  card.nextReview = nextDate.toISOString();
  card.lastReviewed = now.toISOString();

  return card;
} 