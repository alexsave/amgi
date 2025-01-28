// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MAX_NEW_CARDS_PER_DAY } from '../utils/constants';
import * as localDeckStorage from '../services/localDeckStorage';
import { getApiMode } from '../network/api';
import { getDueCards } from '../algorithms/spacedRepetition';
import { useAuth } from './AuthContext';

const DeckContext = createContext({});

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [loading, setLoading] = useState(true);
  const [currentDeck, setCurrentDeck] = useState(null);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [dueCards, setDueCards] = useState([]);
  const [error, setError] = useState(null);
  const { user, isDirectMode } = useAuth();
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

  useEffect(() => {
    const loadDecks = () => {
      try {
        // Always load decks from localStorage first
        const localDecks = localDeckStorage.getLocalDecks();
        console.log('Loaded local decks:', localDecks);
        setDecks(localDecks);
        
        if (user) {
          // TODO: In the future, merge with cloud storage
          // For now, still use localStorage
        }
      } catch (error) {
        console.error('Error loading decks:', error);
        setDecks({});
      } finally {
        setLoading(false);
      }
    };

    loadDecks();
  }, [user]);

  const saveDecks = (newDecks) => {
    console.log('Saving decks:', newDecks);
    // Always save to localStorage
    localDeckStorage.saveLocalDecks(newDecks);
    
    if (user) {
      // TODO: In the future, also save to cloud storage
    }
    setDecks(newDecks);
  };

  const createNewDeck = async (name) => {
    console.log('Creating new deck:', name);
    const id = Date.now().toString();
    const newDeck = {
      id,
      name,
      cards: [],
      created: Date.now(),
      lastModified: Date.now()
    };
    
    const newDecks = { ...decks, [id]: newDeck };
    saveDecks(newDecks);
    return id;
  };

  const updateDeck = (deckId, updatedDeck) => {
    console.log('Updating deck:', deckId, updatedDeck);
    const newDecks = { ...decks, [deckId]: updatedDeck };
    saveDecks(newDecks);
  };

  const deleteDeck = (deckId) => {
    console.log('Deleting deck:', deckId);
    const newDecks = { ...decks };
    delete newDecks[deckId];
    saveDecks(newDecks);
  };

  // Load initial data
  useEffect(() => {
    // Always load from local storage
    const localDecks = localDeckStorage.getLocalDecks();
    console.log('Initial load of local decks:', localDecks);
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
  }, []);

  // Save decks whenever they change
  useEffect(() => {
    if (Object.keys(decks).length > 0) {
      localDeckStorage.saveLocalDecks(decks);
      if (currentDeck) {
        localDeckStorage.saveCurrentDeck(currentDeck);
      }
    }
  }, [decks, currentDeck]);

  // Save new cards count whenever it changes
  useEffect(() => {
    localDeckStorage.saveNewCardsToday(newCardsToday);
  }, [newCardsToday]);

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

  const addCardToDeck = async (deckId, card) => {
    if (isDirectMode) {
      const updatedDeck = localDeckStorage.addCardToLocalDeck(deckId, card);
      setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      return updatedDeck;
    } else {
      // TODO: Implement server card addition
    }
  };

  const deleteCard = async (deckId, cardId) => {
    if (isDirectMode) {
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
    loading,
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

export const useDecks = () => {
  const context = useContext(DeckContext);
  if (!context) {
    throw new Error('useDecks must be used within a DeckProvider');
  }
  return context;
}; 