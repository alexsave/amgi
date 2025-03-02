// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { MAX_NEW_CARDS_PER_DAY } from '../utils/constants';
import * as localDeckStorage from '../services/localDeckStorage';
import * as supabase from '../db/supabase';
import { getDueCards } from '../algorithms/spacedRepetition';
import { useAuth } from './AuthContext';

const DeckContext = createContext({});

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [loading, setLoading] = useState(true);
  const [currentDeckId, setCurrentDeckId] = useState(null);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [dueCards, setDueCards] = useState([]);
  const [error, setError] = useState(null);
  const { user, isDirectMode } = useAuth();
  const location = useLocation();

  // Add refs for tracking load state and debouncing
  const initialLoadComplete = useRef(false);
  const loadDecksTimeout = useRef(null);
  const lastAuthState = useRef({ user: null, isDirectMode: false });

  // Derive mode from location
  const getMode = () => {
    const path = location.pathname;
    if (path === '/decks') return 'list';
    if (path.includes('/review')) return 'review';
    if (path.includes('/edit')) return 'edit';
    if (path.includes('/create')) return 'create';
    return 'view';
  };

  // Debounced loadDecks function
  const debouncedLoadDecks = () => {
    if (loadDecksTimeout.current) {
      clearTimeout(loadDecksTimeout.current);
    }

    loadDecksTimeout.current = setTimeout(async () => {
      try {
        // Always load decks from localStorage first
        const localDecks = localDeckStorage.getLocalDecks();
        // this gets called for some reason when we hit generate WHY
        if (Object.keys(localDecks).length > 0) {
          setDecks(localDecks);
        }
        
        // Only load from Supabase if:
        // 1. We have a user
        // 2. We're not in direct mode
        // 3. The auth state has actually changed
        if (user && !isDirectMode && 
            (lastAuthState.current.user?.id !== user.id || 
             lastAuthState.current.isDirectMode !== isDirectMode)) {
          const cloudDecks = await supabase.loadDecks(user.id);
          setDecks(cloudDecks);
          localDeckStorage.saveLocalDecks(cloudDecks);
          
          // Update last auth state
          lastAuthState.current = { user, isDirectMode };
        } else {
        }

        // Mark initial load as complete
        initialLoadComplete.current = true;
      } catch (error) {
        console.error('Error loading decks:', error);
        setError(error.message);
      } finally {
        setLoading(false);
      }
    }, 300); // 300ms debounce
  };

  // Effect for loading decks
  useEffect(() => {
    // Skip if we've already done the initial load and auth state hasn't changed
    if (initialLoadComplete.current && 
        lastAuthState.current.user?.id === user?.id && 
        lastAuthState.current.isDirectMode === isDirectMode) {
      return;
    }

    debouncedLoadDecks();

    // Cleanup
    return () => {
      if (loadDecksTimeout.current) {
        clearTimeout(loadDecksTimeout.current);
      }
    };
  }, [user, isDirectMode]);

  const saveDecks = async (newDecks) => {
    // Always save to localStorage
    localDeckStorage.saveLocalDecks(newDecks);
    
    if (user && !isDirectMode) {
      // Save each deck to Supabase
      try {
        // Put this all in a single transaction
        await Promise.all(
          Object.values(newDecks).map(deck => supabase.saveDeck(deck, user.id))
        );
      } catch (error) {
        console.error('Error saving decks to cloud:', error);
        setError(error.message);
      }
    }
    setDecks(newDecks);
  };

  const createNewDeck = async (deckData) => {
    console.log('Creating new deck with data:', deckData);
    const timestamp = Date.now();
    const { name, known_language = 'en', learning_language } = deckData;
    
    try {
      if (user && !isDirectMode) {
        // Create in Supabase
        const newDeck = await supabase.saveDeck({
          name,
          known_language,
          learning_language,
          created_at: new Date(timestamp).toISOString(),
          cards: {}
        }, user.id);
        
        const transformedDeck = {
          id: newDeck.id,
          name: newDeck.name,
          known_language: newDeck.known_language,
          learning_language: newDeck.learning_language,
          cards: [],
          created: timestamp,
          lastModified: timestamp
        };
        
        setDecks(prev => ({ ...prev, [newDeck.id]: transformedDeck }));
        return newDeck.id;
      } else {
        // Create in local storage only
        const id = timestamp.toString();
        const newDeck = {
          id,
          name,
          known_language,
          learning_language,
          cards: [],
          created: timestamp,
          lastModified: timestamp
        };
        
        const newDecks = { ...decks, [id]: newDeck };
        await saveDecks(newDecks);
        return id;
      }
    } catch (error) {
      console.error('Error creating deck:', error);
      setError(error.message);
      throw error;
    }
  };

  const updateDeck = (deckId, updatedDeck) => {
    const newDecks = { ...decks, [deckId]: updatedDeck };
    saveDecks(newDecks);
  };

  const deleteDeck = async (deckId) => {
    if (user && !isDirectMode) {
      try {
        await supabase.deleteDeck(deckId, user.id);
      } catch (error) {
        console.error('Error deleting deck from cloud:', error);
        setError(error.message);
        throw error;
      }
    }
    // Delete from local storage
    localDeckStorage.deleteLocalDeck(deckId);

    // Delete from local state
    setDecks(prev => {
      // It's an object, so we need to filter it
      const newDecks = { ...prev };
      delete newDecks[deckId];
      return newDecks;
    });

    // If the call succeeded, we shouldn't have to save the decks again
    //saveDecks(newDecks);
  };

  // Load initial data
  useEffect(() => {
    // Always load from local storage
    const localDecks = localDeckStorage.getLocalDecks();
    setDecks(localDecks);
    
    const lastDeckId = localDeckStorage.loadCurrentDeck();
    if (lastDeckId && localDecks[lastDeckId]) {
      setCurrentDeckId(lastDeckId);
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
    /*if (Object.keys(decks).length > 0) {
      localDeckStorage.saveLocalDecks(decks);
      if (currentDeck) {
        localDeckStorage.saveCurrentDeck(currentDeck);
      }
    }*/
  }, [decks, currentDeckId]);

  // Save new cards count whenever it changes
  useEffect(() => {
    localDeckStorage.saveNewCardsToday(newCardsToday);
  }, [newCardsToday]);

  // Update due cards when necessary
  useEffect(() => {
    if (currentDeckId && getMode() === 'review') {
      // Wtf is this
      const due = getDueCards(decks[currentDeckId], MAX_NEW_CARDS_PER_DAY, newCardsToday);
      setDueCards(due);

    }
  }, [currentDeckId, location.pathname, decks, newCardsToday]);

  const addCardToDeck = async (deckId, cardInput) => {
    try {
      // Normalize input to always be an array
      const cards = Array.isArray(cardInput) ? cardInput : [cardInput];
      
      if (user && !isDirectMode) {
        // Add to Supabase using the unified saveCards function
        const newCards = await supabase.saveCards(deckId, cards);
        
        // Create initial reviews for all cards in a single operation
        const cardIds = newCards.map(card => card.id);
        const reviews = await supabase.newReview(cardIds, user.id);
        
        // Update local state
        setDecks(prev => {
          const deck = prev[deckId];
          const transformedCards = newCards.map((card, index) => ({
            id: card.id,
            front_text: card.front_text,
            back_text: card.back_text,
            front_audio_path: card.front_audio_path,
            back_audio_path: card.back_audio_path,
            created: new Date(card.created_at).getTime(),
            review: Array.isArray(reviews) ? reviews[index] : reviews
          }));
          
          return {
            ...prev,
            [deckId]: {
              ...deck,
              cards: [...deck.cards, ...transformedCards],
              lastModified: Date.now()
            }
          };
        });
        
        // If original input was a single card, return just the first card
        return Array.isArray(cardInput) ? newCards : newCards[0];
      } else {
        // Add to local storage
        let updatedDeck = decks[deckId];
        for (const card of cards) {
          updatedDeck = localDeckStorage.addCardToLocalDeck(deckId, card);
        }
        setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
        
        // Return appropriate card data
        const newCards = updatedDeck.cards.slice(-cards.length);
        return Array.isArray(cardInput) ? newCards : newCards[0];
      }
    } catch (error) {
      console.error('Error adding card(s):', error);
      setError(error.message);
      throw error;
    }
  };

  const value = {
    decks,
    loading,
    currentDeckId,
    getMode,
    newCardsToday,
    dueCards,
    error,
    setCurrentDeckId,
    setNewCardsToday,
    setError,
    createNewDeck,
    updateDeck,
    deleteDeck,
    addCardToDeck,
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