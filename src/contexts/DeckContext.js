// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { MAX_NEW_CARDS_PER_DAY } from '../utils/constants';
import * as localDeckStorage from '../services/localDeckStorage';
import * as supabase from '../db/supabase';
import { getApiMode } from '../network/api';
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

  const createNewDeck = async (name) => {
    const timestamp = Date.now();
    
    try {
      if (user && !isDirectMode) {
        // Create in Supabase
        const newDeck = await supabase.saveDeck({
          name,
          created_at: new Date(timestamp).toISOString(),
          cards: {}
        }, user.id);
        
        const transformedDeck = {
          id: newDeck.id,
          name: newDeck.name,
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
      const due = getDueCards(decks[currentDeckId], MAX_NEW_CARDS_PER_DAY, newCardsToday);
      setDueCards(due);

      // Check for due cards every minute
      /*const interval = setInterval(() => {
        const updated = getDueCards(decks[currentDeckId], MAX_NEW_CARDS_PER_DAY, newCardsToday);
        setDueCards(updated);
      }, 60000);

      return () => clearInterval(interval);*/
    }
  }, [currentDeckId, location.pathname, decks, newCardsToday]);

  const addCardToDeck = async (deckId, card) => {
    try {
      if (user && !isDirectMode) {
        // Add to Supabase
        const newCard = await supabase.saveCard(deckId, {
          front_text: card.front_text,
          back_text: card.back_text,
          front_lang: card.front_lang,
          back_lang: card.back_lang,
          front_audio_path: card.frontAudioPath,
          back_audio_path: card.backAudioPath,
          created_at: new Date(Date.now()).toISOString()
        });
        
        // Create initial review
        const review = await supabase.newReview(newCard.id, user.id);
        
        // Update local state
        setDecks(prev => {
          const deck = prev[deckId];
          const transformedCard = {
            id: newCard.id,
            front: newCard.front_text,
            front_text: newCard.front_text,
            back: newCard.back_text,
            frontAudio: newCard.front_audio_url,
            backAudio: newCard.back_audio_url,
            created: new Date(newCard.created_at).getTime(),
            review: review
          };
          
          return {
            ...prev,
            [deckId]: {
              ...deck,
              cards: [...deck.cards, transformedCard],
              lastModified: Date.now()
            }
          };
        });
      } else {
        // Add to local storage only
        const updatedDeck = localDeckStorage.addCardToLocalDeck(deckId, card);
        setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      }
    } catch (error) {
      console.error('Error adding card:', error);
      setError(error.message);
      throw error;
    }
  };

  const deleteCard = async (deckId, cardId) => {
    /*try {
      if (user && !isDirectMode) {
        // Delete from Supabase
        await supabase.deleteCard(cardId);
        
        // Update local state
        setDecks(prev => {
          const deck = prev[deckId];
          return {
            ...prev,
            [deckId]: {
              ...deck,
              cards: deck.cards.filter(c => c.id !== cardId),
              lastModified: Date.now()
            }
          };
        });
      } else {
        // Delete from local storage only
        const updatedDeck = localDeckStorage.deleteLocalCard(deckId, cardId);
        setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
      }
    } catch (error) {
      console.error('Error deleting card:', error);
      setError(error.message);
      throw error;
    }*/
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
    deleteCard,
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