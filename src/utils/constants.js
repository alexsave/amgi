// Application constants

export const MAX_NEW_CARDS_PER_DAY = 25;

export const LANGUAGES = {
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  en: 'English'
};

export const REVIEW_MODES = {
  LIST: 'list',
  EDIT: 'edit',
  REVIEW: 'review'
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