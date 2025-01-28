const DECKS_STORAGE_KEY = 'amgi_decks';
const CURRENT_DECK_KEY = 'amgi_current_deck';
const NEW_CARDS_TODAY_KEY = 'amgi_new_cards_today';
const LAST_RESET_DATE_KEY = 'amgi_last_reset_date';

export const getLocalDecks = () => {
  const decksJson = localStorage.getItem(DECKS_STORAGE_KEY);
  return decksJson ? JSON.parse(decksJson) : {};
};

export const saveLocalDecks = (decks) => {
  localStorage.setItem(DECKS_STORAGE_KEY, JSON.stringify(decks));
};

export const loadCurrentDeck = () => {
  return localStorage.getItem(CURRENT_DECK_KEY);
};

export const saveCurrentDeck = (deckId) => {
  localStorage.setItem(CURRENT_DECK_KEY, deckId);
};

export const loadNewCardsToday = () => {
  const count = localStorage.getItem(NEW_CARDS_TODAY_KEY);
  return count ? parseInt(count, 10) : 0;
};

export const saveNewCardsToday = (count) => {
  localStorage.setItem(NEW_CARDS_TODAY_KEY, count.toString());
};

export const resetDailyCounters = () => {
  const today = new Date().toDateString();
  const lastReset = localStorage.getItem(LAST_RESET_DATE_KEY);
  
  if (lastReset !== today) {
    localStorage.setItem(LAST_RESET_DATE_KEY, today);
    localStorage.setItem(NEW_CARDS_TODAY_KEY, '0');
    return true;
  }
  
  return false;
};

export const addCardToLocalDeck = (deckId, card) => {
  const decks = getLocalDecks();
  if (!decks[deckId]) {
    decks[deckId] = {
      id: deckId,
      name: 'My Deck',
      cards: []
    };
  }
  decks[deckId].cards.push({
    ...card,
    id: `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  });
  saveLocalDecks(decks);
  return decks[deckId];
};

export const createLocalDeck = (name) => {
  const decks = getLocalDecks();
  const id = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  decks[id] = {
    id,
    name,
    cards: [],
    created: Date.now(),
    lastModified: Date.now()
  };
  saveLocalDecks(decks);
  return id;
};

export const updateLocalDeck = (deckId, updates) => {
  const decks = getLocalDecks();
  if (decks[deckId]) {
    decks[deckId] = { ...decks[deckId], ...updates };
    saveLocalDecks(decks);
  }
  return decks[deckId];
};

export const deleteLocalDeck = (deckId) => {
  const decks = getLocalDecks();
  delete decks[deckId];
  saveLocalDecks(decks);
};

export const deleteLocalCard = (deckId, cardId) => {
  const decks = getLocalDecks();
  if (decks[deckId]) {
    decks[deckId].cards = decks[deckId].cards.filter(card => card.id !== cardId);
    saveLocalDecks(decks);
  }
  return decks[deckId];
}; 