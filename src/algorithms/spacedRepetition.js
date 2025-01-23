// Spaced repetition algorithm implementation

export const updateCardScheduling = (card, quality) => {
  console.log('Starting updateCardScheduling:', { quality });
  
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
  const now = new Date();
  const dueDate = card.nextReview ? new Date(card.nextReview) : now;
  const daysLate = Math.max(0, (now - dueDate) / (1000 * 60 * 60 * 24));
  
  if (quality === 'correct') { // Correct response
    console.log('Correct response, updating intervals');
    // Clear any due timestamp since it passed review
    card.dueTimestamp = null;
    
    if (card.repetitions === 0) {
      card.interval = 1; // First interval
    } else if (card.repetitions === 1) {
      card.interval = 6; // Second interval
    } else {
      // Calculate new interval with late bonus
      const newInterval = Math.round(card.interval * card.easeFactor * (1 + 0.2 * daysLate));
      console.log('Calculating new interval:', {
        currentInterval: card.interval,
        easeFactor: card.easeFactor,
        daysLate,
        newInterval
      });
      // Cap at 10 years
      card.interval = Math.max(card.interval + 1, Math.min(newInterval, 365 * 10));
    }
    card.repetitions += 1;
    
    // Ensure minimum ease of 130%
    card.easeFactor = Math.max(1.3, card.easeFactor);
  } else { // Incorrect response
    console.log('Incorrect response, resetting interval');
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
    console.log('Set due timestamp to:', card.dueTimestamp);
  }

  try {
    // Calculate next review date
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + card.interval);
    card.nextReview = nextDate.toISOString();
    console.log('Set next review to:', card.nextReview);
  } catch (err) {
    console.error('Error calculating next review date:', err);
    // Fallback to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    card.nextReview = tomorrow.toISOString();
    console.log('Used fallback date:', card.nextReview);
  }

  card.lastReviewed = new Date().toISOString();
  
  console.log('Final card state:', {
    interval: card.interval,
    repetitions: card.repetitions,
    easeFactor: card.easeFactor,
    lastReviewed: card.lastReviewed,
    nextReview: card.nextReview,
    dueTimestamp: card.dueTimestamp
  });

  return card;
};

export const getDueCards = (deck, maxNewCardsPerDay, newCardsToday) => {
  if (!deck) return [];

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

  // Limit new cards based on daily limit while preserving order
  const availableNewCards = newCards.slice(0, maxNewCardsPerDay - newCardsToday);
  
  // Sort review cards by due date/timestamp
  const sortedReviewCards = [...reviewCards].sort((a, b) => {
    const aTime = a.dueTimestamp ? new Date(a.dueTimestamp) : new Date(a.nextReview);
    const bTime = b.dueTimestamp ? new Date(b.dueTimestamp) : new Date(b.nextReview);
    return aTime - bTime;
  });
  
  // Return new cards first (in original order), then review cards (sorted by due time)
  return [...availableNewCards, ...sortedReviewCards];
}; 