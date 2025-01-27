// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MAX_NEW_CARDS_PER_DAY } from '../utils/constants';
import * as localDeckStorage from '../services/localDeckStorage';
import { getApiMode } from '../network/api';
import { getDueCards } from '../algorithms/spacedRepetition';

const DeckContext = createContext(null);

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [currentDeck, setCurrentDeck] = useState(null);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [dueCards, setDueCards] = useState([]);
  const [error, setError] = useState(null);
  const { useDirectApi } = getApiMode();
  const location = useLocation();

  // Derive mode from location
  const getMode = () => {
    const path = location.pathname;
    if (path === '/decks') return 'list';
    if (path.includes('/review')) return 'review';
    if (path.includes('/edit')) return 'edit';
    if (path.includes('/create')) return 'create';
    return 'view';
  };

  // Load initial data
  useEffect(() => {
    if (useDirectApi) {
      // Load from local storage
      const localDecks = localDeckStorage.getLocalDecks();
      setDecks(localDecks);
      
      const lastDeckId = localDeckStorage.loadCurrentDeck();
      if (lastDeckId && localDecks[lastDeckId]) {
        setCurrentDeck(lastDeckId);
      }

      // Reset daily counters if needed
      if (localDeckStorage.resetDailyCounters()) {
        setNewCardsToday(0);
      } else {
        setNewCardsToday(localDeckStorage.loadNewCardsToday());
      }
    } else {
      // TODO: Implement server loading
    }
  }, [useDirectApi]);

  // Save decks whenever they change
  useEffect(() => {
    if (Object.keys(decks).length > 0) {
      if (useDirectApi) {
        localDeckStorage.saveLocalDecks(decks);
        if (currentDeck) {
          localDeckStorage.saveCurrentDeck(currentDeck);
        }
      } else {
        // TODO: Implement server saving
      }
    }
  }, [decks, currentDeck, useDirectApi]);

  // Save new cards count whenever it changes
  useEffect(() => {
    if (useDirectApi) {
      localDeckStorage.saveNewCardsToday(newCardsToday);
    }
  }, [newCardsToday, useDirectApi]);

  // Update due cards when necessary
  useEffect(() => {
    if (currentDeck && getMode() === 'review') {
      const due = getDueCards(decks[currentDeck], MAX_NEW_CARDS_PER_DAY, newCardsToday);
      setDueCards(due);

      // Check for due cards every minute
      const interval = setInterval(() => {
        const updated = getDueCards(decks[currentDeck], MAX_NEW_CARDS_PER_DAY, newCardsToday);
        setDueCards(updated);
      }, 60000);

      return () => clearInterval(interval);
    }
  }, [currentDeck, location.pathname, decks, newCardsToday]);

  const createNewDeck = async (name) => {
    if (useDirectApi) {
      const newDeck = localDeckStorage.createLocalDeck(name);
      setDecks(prev => ({ ...prev, [newDeck.id]: newDeck }));
      return newDeck.id;
    } else {
      // TODO: Implement server deck creation
    }
  };

  const updateDeck = async (deckId, updates) => {
    if (useDirectApi) {
      const updatedDeck = localDeckStorage.updateLocalDeck(deckId, updates);
      setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      return updatedDeck;
    } else {
      // TODO: Implement server deck update
    }
  };

  const deleteDeck = async (deckId) => {
    if (useDirectApi) {
      localDeckStorage.deleteLocalDeck(deckId);
      setDecks(prev => {
        const newDecks = { ...prev };
        delete newDecks[deckId];
        return newDecks;
      });
    } else {
      // TODO: Implement server deck deletion
    }
    if (currentDeck === deckId) {
      setCurrentDeck(null);
    }
  };

  const addCardToDeck = async (deckId, card) => {
    if (useDirectApi) {
      const updatedDeck = localDeckStorage.addCardToLocalDeck(deckId, card);
      setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      return updatedDeck;
    } else {
      // TODO: Implement server card addition
    }
  };

  const deleteCard = async (deckId, cardId) => {
    if (useDirectApi) {
      const updatedDeck = localDeckStorage.deleteLocalCard(deckId, cardId);
      setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      return updatedDeck;
    } else {
      // TODO: Implement server card deletion
    }
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
    mode: getMode(),
    newCardsToday,
    dueCards,
    error,
    setCurrentDeck,
    setNewCardsToday,
    setError,
    createNewDeck,
    updateDeck,
    deleteDeck,
    addCardToDeck,
    deleteCard,
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