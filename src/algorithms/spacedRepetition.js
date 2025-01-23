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
  const daysLate = Math.max(0, (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  
  if (quality === 'correct') { // Correct response
    console.log('Correct response, updating intervals');
    // Clear any due timestamp since it passed review
    card.dueTimestamp = null;
    
    // Calculate base interval
    let baseInterval;
    if (card.repetitions === 0) {
      baseInterval = 1; // First interval
    } else if (card.repetitions === 1) {
      baseInterval = 6; // Second interval
    } else {
      baseInterval = card.interval;
    }

    // Simple late bonus calculation:
    // First apply late bonus, then ease factor for 3rd+ reviews
    const lateBonus = 1 + 0.2 * daysLate;
    const intervalWithBonus = baseInterval * lateBonus;
    const rawInterval = card.repetitions > 1 ? 
      intervalWithBonus * card.easeFactor : 
      intervalWithBonus;
    
    // Round to nearest integer
    const newInterval = Math.round(rawInterval);
    
    console.log('Calculating new interval:', {
      baseInterval,
      easeFactor: card.easeFactor,
      daysLate,
      lateBonus,
      intervalWithBonus,
      rawInterval,
      newInterval
    });

    // Cap at 10 years
    card.interval = Math.min(newInterval, 365 * 10);
    card.repetitions += 1;
    
    // Ensure minimum ease of 130%
    card.easeFactor = Math.max(1.3, card.easeFactor);
  } else { // Incorrect response
    console.log('Incorrect response, resetting interval');
    // Reset interval and reduce ease
    card.interval = 1;
    card.repetitions = 0;
    
    // Always decrease ease factor on incorrect response
    card.easeFactor = Math.max(1.3, card.easeFactor - 0.2); // 20 percentage point decrease, minimum 130%
    
    // Set to be reviewed in 10 minutes
    const dueTime = new Date(now.getTime() + 10 * 60 * 1000);
    card.dueTimestamp = dueTime.toISOString();
    console.log('Set due timestamp to:', card.dueTimestamp);
  }

  // Calculate next review date
  const nextDate = new Date(now.getTime() + card.interval * 24 * 60 * 60 * 1000);
  card.nextReview = nextDate.toISOString();
  console.log('Set next review to:', card.nextReview);

  card.lastReviewed = now.toISOString();
  
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
  
  // Only include new cards if we haven't hit the daily limit
  const newCards = newCardsToday >= maxNewCardsPerDay ? [] : 
    deck.cards.filter(card => !card.lastReviewed)
      .slice(0, maxNewCardsPerDay - newCardsToday);

  const reviewCards = deck.cards.filter(card => {
    if (!card.lastReviewed) return false;
    
    // If the card has a due timestamp (for cards due in minutes), check against that
    if (card.dueTimestamp) {
      const dueTime = new Date(card.dueTimestamp);
      // Only show if it's due and the regular review time hasn't passed
      if (card.nextReview) {
        const reviewTime = new Date(card.nextReview);
        return dueTime <= now && reviewTime > now;
      }
      return dueTime <= now;
    }
    
    // Otherwise check against next review timestamp
    if (!card.nextReview) return false;
    const reviewTime = new Date(card.nextReview);
    return reviewTime <= now;
  });

  // Sort review cards by due date/timestamp
  const sortedReviewCards = [...reviewCards].sort((a, b) => {
    const aTime = a.dueTimestamp ? new Date(a.dueTimestamp) : new Date(a.nextReview);
    const bTime = b.dueTimestamp ? new Date(b.dueTimestamp) : new Date(b.nextReview);
    return aTime.getTime() - bTime.getTime();
  });
  
  // Return new cards first (in original order), then review cards (sorted by due time)
  return [...newCards, ...sortedReviewCards];
}; 