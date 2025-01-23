// Local storage database operations

const STORAGE_KEYS = {
  DECKS: 'decks',
  CURRENT_DECK: 'currentDeck',
  NEW_CARDS_TODAY: 'newCardsToday',
  LAST_REVIEW_DATE: 'lastReviewDate'
};

export const loadDecks = () => {
  try {
    const savedDecks = localStorage.getItem(STORAGE_KEYS.DECKS);
    return savedDecks ? JSON.parse(savedDecks) : {};
  } catch (err) {
    console.error('Error loading decks:', err);
    return {};
  }
};

export const saveDecks = (decks) => {
  try {
    localStorage.setItem(STORAGE_KEYS.DECKS, JSON.stringify(decks));
  } catch (err) {
    console.error('Error saving decks:', err);
  }
};

export const loadCurrentDeck = () => {
  return localStorage.getItem(STORAGE_KEYS.CURRENT_DECK);
};

export const saveCurrentDeck = (deckId) => {
  localStorage.setItem(STORAGE_KEYS.CURRENT_DECK, deckId);
};

export const loadNewCardsToday = () => {
  return parseInt(localStorage.getItem(STORAGE_KEYS.NEW_CARDS_TODAY) || '0', 10);
};

export const saveNewCardsToday = (count) => {
  localStorage.setItem(STORAGE_KEYS.NEW_CARDS_TODAY, count.toString());
};

export const loadLastReviewDate = () => {
  return localStorage.getItem(STORAGE_KEYS.LAST_REVIEW_DATE);
};

export const saveLastReviewDate = (date) => {
  localStorage.setItem(STORAGE_KEYS.LAST_REVIEW_DATE, date);
};

export const resetDailyCounters = () => {
  const today = new Date().toISOString().split('T')[0];
  const lastReviewDate = loadLastReviewDate();
  
  if (lastReviewDate !== today) {
    saveNewCardsToday(0);
    saveLastReviewDate(today);
    return true;
  }
  return false;
}; 