// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState } from 'react';
import { MAX_NEW_CARDS_PER_DAY, REVIEW_MODES } from '../utils/constants';
import * as db from '../db/localStorage';
import { getDueCards } from '../algorithms/spacedRepetition';

const DeckContext = createContext(null);

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [currentDeck, setCurrentDeck] = useState(null);
  const [mode, setMode] = useState(REVIEW_MODES.LIST);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [dueCards, setDueCards] = useState([]);
  const [error, setError] = useState(null);

  // Load initial data
  useEffect(() => {
    const loadedDecks = db.loadDecks();
    setDecks(loadedDecks);
    
    const lastDeckId = db.loadCurrentDeck();
    if (lastDeckId && loadedDecks[lastDeckId]) {
      setCurrentDeck(lastDeckId);
    }

    // Reset daily counters if needed
    if (db.resetDailyCounters()) {
      setNewCardsToday(0);
    } else {
      setNewCardsToday(db.loadNewCardsToday());
    }
  }, []);

  // Save decks whenever they change
  useEffect(() => {
    if (Object.keys(decks).length > 0) {
      db.saveDecks(decks);
      if (currentDeck) {
        db.saveCurrentDeck(currentDeck);
      }
    }
  }, [decks, currentDeck]);

  // Save new cards count whenever it changes
  useEffect(() => {
    db.saveNewCardsToday(newCardsToday);
  }, [newCardsToday]);

  // Update due cards when necessary
  useEffect(() => {
    if (currentDeck && mode === REVIEW_MODES.REVIEW) {
      const due = getDueCards(decks[currentDeck], MAX_NEW_CARDS_PER_DAY, newCardsToday);
      setDueCards(due);

      // Check for due cards every minute
      const interval = setInterval(() => {
        const updated = getDueCards(decks[currentDeck], MAX_NEW_CARDS_PER_DAY, newCardsToday);
        setDueCards(updated);
      }, 60000);

      return () => clearInterval(interval);
    }
  }, [currentDeck, mode, decks, newCardsToday]);

  const createNewDeck = (name) => {
    if (!name) return;
    
    const id = Date.now().toString();
    const newDeck = {
      name,
      cards: [],
      created: Date.now(),
      lastModified: Date.now()
    };
    
    setDecks(prev => ({
      ...prev,
      [id]: newDeck
    }));
    setCurrentDeck(id);
    return id;
  };

  const deleteDeck = (deckId) => {
    setDecks(prev => {
      const newDecks = { ...prev };
      delete newDecks[deckId];
      return newDecks;
    });
    if (currentDeck === deckId) {
      setCurrentDeck(null);
      setMode(REVIEW_MODES.LIST);
    }
  };

  const addCardToDeck = (deckId, card) => {
    setDecks(prev => ({
      ...prev,
      [deckId]: {
        ...prev[deckId],
        cards: [...prev[deckId].cards, card],
        lastModified: Date.now()
      }
    }));
  };

  const updateCard = (deckId, cardId, updates) => {
    setDecks(prev => {
      const deck = prev[deckId];
      const cardIndex = deck.cards.findIndex(c => c.created === cardId);
      if (cardIndex === -1) return prev;

      const updatedCards = [...deck.cards];
      updatedCards[cardIndex] = { ...updatedCards[cardIndex], ...updates };

      return {
        ...prev,
        [deckId]: {
          ...deck,
          cards: updatedCards,
          lastModified: Date.now()
        }
      };
    });
  };

  const value = {
    decks,
    setDecks,
    currentDeck,
    mode,
    newCardsToday,
    dueCards,
    error,
    setCurrentDeck,
    setMode,
    setNewCardsToday,
    setError,
    createNewDeck,
    deleteDeck,
    addCardToDeck,
    updateCard
  };

  return (
    <DeckContext.Provider value={value}>
      {children}
    </DeckContext.Provider>
  );
};

export const useDeckContext = () => {
  const context = useContext(DeckContext);
  if (!context) {
    throw new Error('useDeckContext must be used within a DeckProvider');
  }
  return context;
}; 