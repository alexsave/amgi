import * as localStorage from './localStorage';
import * as supabase from './supabase';

const USE_LOCAL = process.env.REACT_APP_USE_LOCAL === 'true';
const db = USE_LOCAL ? localStorage : supabase;

// Wrap async functions to handle both sync and async calls
export const loadDecks = async () => {
  return db.loadDecks();
};

export const saveDeck = async (deck) => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    decks[deck.id] = deck;
    return db.saveDecks(decks);
  }
  return db.saveDeck(deck);
};

export const saveCard = async (deckId, card) => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    if (!decks[deckId]) return;
    decks[deckId].cards = decks[deckId].cards || {};
    decks[deckId].cards[card.id] = card;
    return db.saveDecks(decks);
  }
  return db.saveCard(deckId, card);
};

export const saveCards = async (deckId, cards) => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    if (!decks[deckId]) return;
    decks[deckId].cards = { ...decks[deckId].cards, ...cards };
    return db.saveDecks(decks);
  }
  return db.saveCards(deckId, cards);
};

export const deleteDeck = async (deckId) => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    delete decks[deckId];
    return db.saveDecks(decks);
  }
  return db.deleteDeck(deckId);
};

export const loadReview = async (cardId) => {
  if (USE_LOCAL) {
    // In localStorage, review data is stored with the card
    const decks = await loadDecks();
    for (const deck of Object.values(decks)) {
      if (deck.cards?.[cardId]?.review) {
        return deck.cards[cardId].review;
      }
    }
    return null;
  }
  return db.loadReview(cardId);
};

export const saveReview = async (cardId, review) => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    for (const deck of Object.values(decks)) {
      if (deck.cards?.[cardId]) {
        deck.cards[cardId].review = review;
        return db.saveDecks(decks);
      }
    }
  }
  return db.saveReview(cardId, review);
};

export const getDueCards = async () => {
  if (USE_LOCAL) {
    const decks = await loadDecks();
    const today = new Date().toISOString().split('T')[0];
    const dueCards = [];

    for (const deck of Object.values(decks)) {
      for (const card of Object.values(deck.cards || {})) {
        if (card.review?.next_review_date <= today) {
          dueCards.push({
            ...card,
            deck_id: deck.id
          });
        }
      }
    }

    return dueCards.sort((a, b) => 
      new Date(a.review?.next_review_date) - new Date(b.review?.next_review_date)
    );
  }
  return db.getDueCards();
};

// These functions are only used in localStorage mode
export const loadCurrentDeck = () => USE_LOCAL ? db.loadCurrentDeck() : null;
export const saveCurrentDeck = (deckId) => USE_LOCAL ? db.saveCurrentDeck(deckId) : null;
export const loadNewCardsToday = () => USE_LOCAL ? db.loadNewCardsToday() : 0;
export const saveNewCardsToday = (count) => USE_LOCAL ? db.saveNewCardsToday(count) : null;
export const resetDailyCounters = () => USE_LOCAL ? db.resetDailyCounters() : false; 