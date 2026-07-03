// Application constants

export const MAX_NEW_CARDS_PER_DAY = 25;

export const ROUTES = {
  DECKS: 'decks',
  DECK_VIEW: 'deck/:id',
  DECK_EDIT: 'deck/:id/edit',
  DECK_REVIEW: 'deck/:id/review',
  CARD_CREATE: 'deck/:id/cards/create',
  CARD_EDIT: 'deck/:id/cards/:cardId/edit'
};

export const EVALUATION_RESULTS = {
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
  QUIT: 'quit'
};

export const AUDIO_SIDES = {
  FRONT: 'front',
  BACK: 'back'
};

export const MAX_ATTEMPTS = 3;
export const REVIEW_DELAY = {
  CORRECT: 2000,  // 2 seconds
  INCORRECT: 0,
  QUIT: 500      // 0.5 seconds
};

export const INITIAL_CARD_STATE = {
  interval: 1,
  easeFactor: 2.5,
  repetitions: 0,
  lastReviewed: null,
  nextReview: null,
  dueTimestamp: null
}; 

export const REALTIME_MODEL = "gpt-realtime";