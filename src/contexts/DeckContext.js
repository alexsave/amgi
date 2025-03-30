// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { MAX_NEW_CARDS_PER_DAY } from '../constants/constants';
import * as supabase from '../db/supabase';
import { useAuth } from './AuthContext';

const DeckContext = createContext({});

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [loading, setLoading] = useState(true);
  const [currentDeckId, setCurrentDeckId] = useState(null);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [error, setError] = useState(null);
  const { user } = useAuth();
  const location = useLocation();

  // Add refs for tracking load state and debouncing
  const initialLoadComplete = useRef(false);
  const loadDecksTimeout = useRef(null);
  const lastAuthState = useRef({ user: null });

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
        // Only load from Supabase if we have a user
        if (user && 
            (lastAuthState.current.user?.id !== user.id)) {
          const cloudDecks = await supabase.loadDecks(user.id);
          setDecks(cloudDecks);
          
          // Update last auth state
          lastAuthState.current = { user };
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
        lastAuthState.current.user?.id === user?.id) {
      return;
    }

    debouncedLoadDecks();

    // Cleanup
    return () => {
      if (loadDecksTimeout.current) {
        clearTimeout(loadDecksTimeout.current);
      }
    };
  }, [user]);

  const saveDecks = async (newDecks) => {
    // Save decks to Supabase if user is authenticated
    if (user) {
      // Instead of using a non-existent saveDecks function, save each deck individually
      try {
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
      if (user) {
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
        // Create in local state only since localStorage is no longer available
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
    if (user) {
      try {
        await supabase.deleteDeck(deckId, user.id);
      } catch (error) {
        console.error('Error deleting deck from cloud:', error);
        setError(error.message);
        throw error;
      }
    }
    // Delete from local state
    setDecks(prev => {
      // It's an object, so we need to filter it
      const newDecks = { ...prev };
      delete newDecks[deckId];
      return newDecks;
    });
  };

  // Update due cards when necessary

  const addCardToDeck = async (deckId, cardInput) => {
    try {
      // Normalize input to always be an array
      const cards = Array.isArray(cardInput) ? cardInput : [cardInput];
      
      // Ensure the deck exists
      const deck = decks[deckId];
      if (!deck) {
        throw new Error(`Deck with ID ${deckId} not found`);
      }
      
      // Ensure language fields are set for all cards
      const processedCards = cards.map(card => {
        const processed = { ...card };
        if (!processed.front_lang) {
          processed.front_lang = deck.known_language || 'en';
          console.log(`Setting missing front_lang to ${processed.front_lang}`);
        }
        if (!processed.back_lang) {
          processed.back_lang = deck.learning_language || 'en';
          console.log(`Setting missing back_lang to ${processed.back_lang}`);
        }
        return processed;
      });
      
      if (user) {
        // Add to Supabase using the unified saveCards function
        const newCards = await supabase.saveCards(deckId, processedCards);
        
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
            front_lang: card.front_lang,
            back_lang: card.back_lang,
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
        // Add to local state only (since localStorage is no longer available)
        const updatedDeck = { ...decks[deckId] };
        const newCards = [];
        
        for (const card of processedCards) {
          const cardId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const newCard = {
            ...card,
            id: cardId,
            created: Date.now()
          };
          
          if (!updatedDeck.cards) {
            updatedDeck.cards = [];
          }
          
          updatedDeck.cards.push(newCard);
          newCards.push(newCard);
        }
        
        updatedDeck.lastModified = Date.now();
        setDecks(prev => ({ ...prev, [deckId]: updatedDeck }));
        
        // Return appropriate card data
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