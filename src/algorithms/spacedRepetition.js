// Spaced repetition algorithm implementation

export function calculateNextReview(review, quality) {
  // Initialize values from review or use defaults
  let interval = review?.interval_days || 1;
  let easeFactor = review?.ease_factor || 2.5;
  let repetitions = review?.repetitions || 0;
  let cardState = review?.card_state || 'new';

  let nextReview;

  if (quality === 'correct') {
    // Calculate next review date first
    const now = new Date();

    if (cardState === 'new') {
      // New steps: 10 minutes
      nextReview = new Date(now.getTime() + 10 * 60 * 1000);
      cardState = 'learning';
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
      cardState = 'review';
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
    if (cardState === 'review') {
      easeFactor -= 0.2; // 20 percentage point decrease, minimum 130%
    }
    cardState = 'learning';
  }
  // Ensure minimum ease of 130%
  easeFactor = Math.max(1.3, easeFactor);

  return {
    interval_days: interval,
    ease_factor: easeFactor,
    repetitions,
    card_state: cardState,
    next_review_date: nextReview.toISOString()
  };
}

/**
 * Process a card review outcome, considering attempts and current state
 * @param {Object} card - The card being reviewed
 * @param {string} outcome - 'correct' or 'incorrect'
 * @param {number} attempts - Number of attempts made on this card
 * @param {number} maxAttempts - Maximum allowed attempts before moving to next card
 * @returns {Object} - Review outcome with scheduling information
 */
export function processCardReview(card, outcome, attempts, maxAttempts = 3) {
  
  // Determine quality based on outcome and attempts
  let quality;
  let nextCardState;
  let shouldReschedule = true;
  
  if (outcome === 'correct') {
    // If correct on first attempt, it's a full success
    // If correct after attempts, it's a partial success
    quality = attempts === 0 ? 'correct' : 'incorrect';
    
    // Calculate the new review data
    const reviewData = calculateNextReview(card.review, quality);
    
    // For correct answers, we always reschedule:
    // - New cards go to learning (10 min)
    // - Learning cards may go to review if first attempt
    // - Review cards stay in review if first attempt
    nextCardState = reviewData.card_state;
    
    // Fix: Always reschedule new cards going to learning state
    // Only mature review cards with correct first-attempt answers should not be rescheduled
    const isNewCard = card.review?.card_state === 'new';
    shouldReschedule = isNewCard || nextCardState !== 'review' || quality === 'incorrect';
    
    return {
      ...reviewData,
      shouldReschedule,
      resetAttempts: true, // Always reset attempts after correct answer
      shouldGoToNextCard: true
    };
    
  } else {
    // For incorrect answers
    
    // Check if we've reached max attempts
    if (attempts >= maxAttempts - 1) {
      // Max attempts reached - calculate review with 'incorrect'
      const reviewData = calculateNextReview(card.review, 'incorrect');
      
      // Card always goes to learning state for incorrect answers
      return {
        ...reviewData,
        shouldReschedule: true,
        resetAttempts: true, // Reset attempts for next card
        shouldGoToNextCard: true
      };
    } else {
      // Still has attempts left - don't recalculate review yet
      // Only update attempts count and keep the same card
      return {
        interval_days: card.review?.interval_days || 1,
        ease_factor: card.review?.ease_factor || 2.5, 
        repetitions: card.review?.repetitions || 0,
        card_state: card.review?.card_state || 'new',
        next_review_date: card.review?.next_review_date || new Date().toISOString(),
        shouldReschedule: true, // This is tricky. If there are still attempts left, we shouldn't do anything. Maybe we should call this "keep in scheduler"?
        shouldGoToNextCard: false,
        resetAttempts: false
      };
    }
  }
}
