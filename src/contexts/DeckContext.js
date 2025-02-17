// Deck context for managing global deck state
import React, { createContext, useContext, useEffect, useState } from 'react';
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
    const loadDecks = async () => {
      try {
        // Always load decks from localStorage first
        const localDecks = localDeckStorage.getLocalDecks();
        setDecks(localDecks);
        
        if (user && !isDirectMode) {
          // Load decks from Supabase
          const cloudDecks = await supabase.loadDecks(user.id);
          setDecks(cloudDecks);
        }
      } catch (error) {
        console.error('Error loading decks:', error);
        setError(error.message);
      } finally {
        setLoading(false);
      }
    };

    loadDecks();
  }, [user, isDirectMode]);

  const saveDecks = async (newDecks) => {
    console.log('Saving decks:', newDecks);
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
    console.log('Creating new deck:', name);
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
    console.log('Updating deck:', deckId, updatedDeck);
    const newDecks = { ...decks, [deckId]: updatedDeck };
    saveDecks(newDecks);
  };

  const deleteDeck = async (deckId) => {
    console.log('Deleting deck:', deckId);
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
      // It's an array, so we need to filter it
      return prev.filter(deck => deck.id !== deckId);
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
    try {
      if (user && !isDirectMode) {
        // Add to Supabase
        const newCard = await supabase.saveCard(deckId, {
          front_text: card.front,
          back_text: card.back,
          front_audio_url: card.frontAudio,
          back_audio_url: card.backAudio,
          created_at: new Date(card.created || Date.now()).toISOString()
        });
        
        // Create initial review
        await supabase.saveReview(newCard.id, {
          scheduled_date: new Date().toISOString().split('T')[0],
          interval_days: 1,
          ease_factor: 2.5,
          repetitions: 0,
          next_review_date: new Date().toISOString().split('T')[0]
        }, user.id);
        
        // Update local state
        setDecks(prev => {
          const deck = prev[deckId];
          const transformedCard = {
            id: newCard.id,
            front: newCard.front_text,
            back: newCard.back_text,
            frontAudio: newCard.front_audio_url,
            backAudio: newCard.back_audio_url,
            created: new Date(newCard.created_at).getTime()
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

  const updateCard = async (deckId, cardId, updates) => {
    try {
      if (user && !isDirectMode) {
        // Update in Supabase
        await supabase.saveCard(deckId, {
          id: cardId,
          front_text: updates.front,
          back_text: updates.back,
          front_audio_url: updates.frontAudio,
          back_audio_url: updates.backAudio
        });
      }
      
      // Update local state
      setDecks(prev => {
        const deck = prev[deckId];
        const cardIndex = deck.cards.findIndex(c => c.id === cardId);
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
    } catch (error) {
      console.error('Error updating card:', error);
      setError(error.message);
      throw error;
    }
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