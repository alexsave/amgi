import * as supabase from './supabase';

export const loadDecks = async () => {
  return supabase.loadDecks();
};

export const saveDeck = async (deck) => {
  return supabase.saveDeck(deck);
};

export const saveCard = async (deckId, card) => {
  return supabase.saveCard(deckId, card);
};

export const saveCards = async (deckId, cards) => {
  // Normalize input to always be an array
  const cardsArray = Array.isArray(cards) ? cards : [cards];
  
  // Use the unified saveCards function from supabase
  return supabase.saveCards(deckId, cardsArray);
};

export const deleteDeck = async (deckId) => {
  return supabase.deleteDeck(deckId);
};

export const loadReview = async (cardId) => {
  return supabase.loadReview(cardId);
};

export const saveReview = async (cardId, review) => {
  return supabase.saveReview(cardId, review);
};

export const getDueCards = async () => {
  return supabase.getDueCards();
}; 