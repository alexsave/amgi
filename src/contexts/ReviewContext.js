import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { useDecks } from './DeckContext';
import { calculateNextReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';
import * as supabase from '../db/supabase';
import { useAuth } from './AuthContext';
import { getLocalDate, parseLocalDate } from '../utils/dates';

const ReviewContext = createContext({});

export const ReviewProvider = ({ children }) => {

  const MAX_ATTEMPTS = 3;

  const location = useLocation();
  const { currentDeckId, decks } = useDecks();
  const { user, isDirectMode } = useAuth();
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);

  // Store cards by ID for easy lookup
  const [cardsById, setCardsById] = useState({});
  const [currentCardId, setCurrentCardId] = useState(null);
  const [newCardsCount, setNewCardsCount] = useState(0);
  const [learningCardsCount, setLearningCardsCount] = useState(0);
  const [reviewCardsCount, setReviewCardsCount] = useState(0);

  const cardSchedulerRef = useRef(new CardScheduler());

  // Update card counts whenever the scheduler changes
  const updateCardCounts = () => {
    setNewCardsCount(cardSchedulerRef.current.getNewCardsCount());
    setLearningCardsCount(cardSchedulerRef.current.getLearningCardsCount());
    setReviewCardsCount(cardSchedulerRef.current.getReviewCardsCount());
  };

  // A utility function to force an update on a card
  const forceCardUpdate = (cardId, newReview) => {
    if (!cardId || !cardsById[cardId]) return false;
    
    console.log('🔄 Force-updating card:', cardId, 'to state:', newReview?.card_state);
    
    // Create a completely new card object
    const cardClone = JSON.parse(JSON.stringify(cardsById[cardId]));
    
    // Update the review data
    if (newReview) {
      cardClone.review = JSON.parse(JSON.stringify(newReview));
    }
    
    // Replace in cardsById
    cardsById[cardId] = cardClone;
    
    // Sync to deck
    syncDeckCardWithCardsById(cardId);
    
    // Update scheduler if needed
    if (newReview && newReview.card_state) {
      const schedulerState = cardSchedulerRef.current.getCardState(cardId);
      if (schedulerState !== newReview.card_state) {
        cardSchedulerRef.current.delete(cardId);
        
        if (newReview.card_state === 'new') {
          cardSchedulerRef.current.pushNewCard(cardId);
        } else {
          const reviewTime = newReview.next_review_date 
            ? new Date(newReview.next_review_date).getTime()
            : Date.now() + 10 * 60 * 1000;
          cardSchedulerRef.current.setReviewTime(cardId, reviewTime, newReview.card_state);
        }
      }
    }
    
    return true;
  };

  // Monitor changes to cardsById and log them
  useEffect(() => {
    console.log('cardsById changed:', cardsById);
    
    // Ensure card counts are updated whenever cardsById changes
    updateCardCounts();
  }, [cardsById]);

  // Monitor changes to currentCardId
  useEffect(() => {
    console.log('currentCardId changed:', currentCardId);
    
    if (currentCardId) {
      // Check if the card exists in cardsById
      const card = cardsById[currentCardId];
      if (card) {
        console.log('Current card data from cardsById:', {
          id: card.id,
          state: card.review?.card_state
        });
        
        // Check what state the card has in the scheduler
        const schedulerState = cardSchedulerRef.current.getCardState(currentCardId);
        console.log('Card state in scheduler:', schedulerState);
        
        // If there's a mismatch, log it
        if (card.review && schedulerState && card.review.card_state !== schedulerState) {
          console.warn('State mismatch! cardsById:', card.review.card_state, 'scheduler:', schedulerState);
        }
      } else {
        console.error('Current card not found in cardsById:', currentCardId);
      }
    }
  }, [currentCardId, cardsById]);

  // Initialize scheduler with deck cards
  useEffect(() => {
    const isReviewMode = location.pathname.includes('/review');
    if (!currentDeckId || !isReviewMode) {
      return;
    }

    const deck = decks[currentDeckId];
    if (!deck) return;

    cardSchedulerRef.current.clear();
    const now = new Date();

    // Build cards by ID map
    const newCardsById = {};
    deck.cards.forEach(card => {
      newCardsById[card.id] = card;
    });
    setCardsById(newCardsById);

    for (let i = 0; i < deck.cards.length; i++) {
      const card = deck.cards[i];
      
      if (!card.review) {
        cardSchedulerRef.current.pushNewCard(card.id);
      } else {
        const reviewTime = card.review.next_review_date ? new Date(card.review.next_review_date).getTime() : now.getTime();
        cardSchedulerRef.current.setReviewTime(
          card.id, 
          reviewTime,
          card.review.card_state
        );
      }
    }
    setCurrentCardId(cardSchedulerRef.current.peekNext());
    updateCardCounts();
  }, [currentDeckId, decks, location]);

  // This function will directly update the deck card references and ensure scheduler consistency
  const syncDeckCardWithCardsById = (cardId) => {
    if (!currentDeckId || !decks[currentDeckId] || !cardsById[cardId]) {
      console.log('Cannot sync - missing deck or card data:', {
        hasDeck: !!decks[currentDeckId],
        hasCard: !!cardsById[cardId]
      });
      return false;
    }
    
    // Get the updated card data
    const updatedCard = cardsById[cardId];
    
    // Find and update the card in the deck
    const deck = decks[currentDeckId];
    const cardIndex = deck.cards.findIndex(c => c.id === cardId);
    
    if (cardIndex >= 0) {
      // Create a deep clone of the updated card to avoid reference issues
      const updatedCardCopy = JSON.parse(JSON.stringify(updatedCard));
      
      // Replace the card in the deck
      deck.cards[cardIndex] = updatedCardCopy;
      console.log('📢 Synchronized deck card with cardsById for card:', cardId);
      
      // Also ensure the scheduler state is consistent
      if (updatedCard.review && updatedCard.review.card_state) {
        const schedulerState = cardSchedulerRef.current.getCardState(cardId);
        
        // If scheduler state differs from card state, update it
        if (schedulerState !== updatedCard.review.card_state) {
          console.log(`🔄 Updating scheduler state: ${schedulerState || 'none'} → ${updatedCard.review.card_state}`);
          
          cardSchedulerRef.current.delete(cardId);
          
          if (updatedCard.review.card_state === 'new') {
            cardSchedulerRef.current.pushNewCard(cardId);
          } else {
            const reviewTime = updatedCard.review.next_review_date 
              ? new Date(updatedCard.review.next_review_date).getTime()
              : Date.now() + 10 * 60 * 1000;
            cardSchedulerRef.current.setReviewTime(cardId, reviewTime, updatedCard.review.card_state);
          }
          
          // Update card counts since we changed scheduler state
          updateCardCounts();
        }
      }
      
      return true;
    }
    
    console.warn('Card not found in deck:', cardId);
    return false;
  };

  const updateCardSchedulingServer = async (cardId, quality) => {
    try {
      console.log(`🔄 Updating card ${cardId} with status: ${quality}`);
      
      if (!currentDeckId || !decks[currentDeckId]) {
        console.error('No deck selected');
        return null;
      }

      // Prepare card data, prioritizing cardsById for most current information
      const cardData = cardsById[cardId];
      
      if (!cardData) {
        console.error('❌ Card not found in cardsById:', cardId);
        return null;
      }
      
      console.log('Card data before update:', {
        cardState: cardData.review?.card_state || 'none',
        nextReview: cardData.review?.next_review_date || 'none'
      });
      
      const { interval, easeFactor, repetitions, nextReview } = calculateNextReview(cardData.review, quality);

      // Update the review in Supabase if we're not in direct mode
      if (user && !isDirectMode) {
        const today = getLocalDate();
        
        // Determine next state based on current state and quality
        let result;
        if (quality === 'correct') {
          if (!cardData.review || cardData.review.card_state === 'new') {
            result = 'learning';
          } else if (cardData.review.card_state === 'learning' && cardData.review.repetitions >= 1) {
            result = 'review';
          } else {
            result = cardData.review.card_state;
          }
        } else {
          result = 'learning';
        }
        
        console.log('Card state transition:', cardData.review?.card_state, '->', result);

        const review = await supabase.saveReview(cardId, {
          interval_days: interval,
          ease_factor: easeFactor,
          repetitions,
          next_review_date: nextReview,
          last_reviewed_at: new Date().toISOString(),
          scheduled_date: today,
          result: quality,
          card_state: result
        }, user.id);

        console.log('After update - Card:', cardId, 'New state:', review.card_state);
        
        // Update local state immediately with the updated review
        // Using setTimeout instead of setImmediate for browser compatibility
        setTimeout(() => {
          try {
            console.log('⚡ Forced synchronous update of cardsById with server response');
            forceCardUpdate(cardId, review);
          } catch (err) {
            console.error('Error in setTimeout callback:', err);
          }
        }, 0);
        
        return review;
      }

      setError(null);
      return cardData.review ? JSON.parse(JSON.stringify(cardData.review)) : null;
    } catch (error) {
      console.error('Error updating card scheduling:', error);
      setError('Failed to update card scheduling');
      return null;
    }
  };

  // Wrap peekNext with debug
  const debugPeekNext = () => {
    const cardId = cardSchedulerRef.current.peekNext();
    console.log('peekNext returned:', cardId);
    
    // If we have a card, check its state
    if (cardId && cardsById[cardId] && cardsById[cardId].review) {
      console.log('Next card state in cardsById:', cardsById[cardId].review.card_state);
      console.log('Next card state in scheduler:', cardSchedulerRef.current.getCardState(cardId));
    }
    
    return cardId;
  };

  // Add a debug wrapper around setCurrentCardId
  const setCurrentCardIdWithDebug = (cardId) => {
    console.log('Setting current card ID:', cardId);
    setCurrentCardId(cardId);
  };

  const markCorrectGetNext = async () => {
    if (!currentCardId) return null;
    
    // Create a fresh copy of the card to avoid reference issues
    // First check if the card exists in cardsById
    const cardRaw = cardsById[currentCardId];
    if (!cardRaw) {
      console.error('Card not found in cardsById:', currentCardId);
      return null;
    }
    
    // Create a deep copy using JSON.parse/stringify to break any object references
    // that might be causing stale data
    const card = JSON.parse(JSON.stringify(cardRaw));
    
    console.log('==== Card Review Process ====');
    console.log('Current card ID:', currentCardId);
    console.log('Raw cardById object:', cardRaw);
    console.log('Fresh deep-copied card:', card);
    console.log('Card state in original cardsById:', cardRaw.review?.card_state);
    console.log('Card state in deep copy:', card.review?.card_state);
    
    // Check if deep copy matches the original
    if (cardRaw.review?.card_state !== card.review?.card_state) {
      console.error('⚠️ Deep copy mismatch! Original:', cardRaw.review?.card_state, 'Copy:', card.review?.card_state);
      // Use the original card's state in this case
      card.review = JSON.parse(JSON.stringify(cardRaw.review || {}));
      console.log('Forced card state in copy to match original:', card.review?.card_state);
      
      // Also fix the original to ensure it's correct going forward
      forceCardUpdate(currentCardId, cardRaw.review);
    }
    
    console.log('Current card scheduler state:', cardSchedulerRef.current.getCardState(currentCardId));
    
    // CRITICAL CHECK: Force reconcile states between cardsById and scheduler 
    if (card.review && cardSchedulerRef.current.getCardState(currentCardId) !== card.review.card_state) {
      console.warn('💥 State mismatch detected - Forcing scheduler state update to match cardsById!');
      
      // Update the scheduler directly with the current card state
      const reviewTime = card.review.next_review_date 
        ? new Date(card.review.next_review_date).getTime()
        : Date.now() + 10 * 60 * 1000;
        
      cardSchedulerRef.current.delete(currentCardId);
      
      if (card.review.card_state === 'new') {
        cardSchedulerRef.current.pushNewCard(currentCardId);
      } else {
        cardSchedulerRef.current.setReviewTime(currentCardId, reviewTime, card.review.card_state);
      }
      
      updateCardCounts();
    }
    
    let updatedReview = null;

    if (attempts > 0) {
      // If we've already tried this card, move it to learning state
      console.log('🔄 Card has prior attempts, marking as incorrect and moving to learning');
      updatedReview = await updateCardSchedulingServer(currentCardId, 'incorrect');
      
      if (updatedReview) {
        // Force update all data structures to be consistent
        forceCardUpdate(currentCardId, updatedReview);
      }
      
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      cardSchedulerRef.current.delete(currentCardId);
      cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');
    } else if (!card.review || card.review.card_state === 'new') {
      console.log('🆕 Marking correct for new card with state:', card.review?.card_state);

      // If it's a new card, move it to learning state
      updatedReview = await updateCardSchedulingServer(currentCardId, 'correct');
      console.log('📈 After server update, card state is now:', updatedReview?.card_state);
      
      if (updatedReview) {
        // Force update all data structures to be consistent
        forceCardUpdate(currentCardId, updatedReview);
      }
      
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      cardSchedulerRef.current.delete(currentCardId);
      cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');
    } else {
      // First attempt success for review or learning card
      // Review card correct - remove from today's queue
      console.log('✅ Marking correct for card with state:', card.review.card_state);
      updatedReview = await updateCardSchedulingServer(currentCardId, 'correct');
      
      if (updatedReview) {
        // Force update all data structures to be consistent
        forceCardUpdate(currentCardId, updatedReview);
      }
      
      cardSchedulerRef.current.delete(currentCardId);
    }

    // Inspect final state
    console.log('Final card state after processing:', updatedReview?.card_state);
    console.log('Final cardsById state:', cardsById[currentCardId]?.review?.card_state);
    console.log('Final scheduler state:', cardSchedulerRef.current.getCardState(currentCardId));

    setAttempts(0);
    // Use our debug wrapper functions
    const nextCardId = debugPeekNext();
    setCurrentCardIdWithDebug(nextCardId);
    updateCardCounts();
    return nextCardId ? cardsById[nextCardId] : null;
  };

  const markIncorrectGetAttempts = () => {
    if (!currentCardId) return { attempts: 0, nextCard: null };

    if (attempts === 0) {
      // First incorrect attempt
      console.log('First incorrect attempt for card:', currentCardId);
      
      // Update card scheduling
      updateCardSchedulingServer(currentCardId, 'incorrect')
        .then(updatedReview => {
          if (updatedReview) {
            console.log('Card updated after incorrect attempt:', updatedReview);
            forceCardUpdate(currentCardId, updatedReview);
          }
        })
        .catch(err => {
          console.error('Error updating card after incorrect attempt:', err);
        });
      
      // Update counts since we're changing the card state
      updateCardCounts();
    }

    if (attempts >= MAX_ATTEMPTS - 1) {
      // Max attempts reached - reschedule in learning state
      console.log('Max attempts reached for card:', currentCardId);
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      cardSchedulerRef.current.delete(currentCardId);
      cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');

      const nextCardId = debugPeekNext();
      setCurrentCardIdWithDebug(nextCardId);
      setAttempts(0);
      updateCardCounts();
      return {
        attempts: 0,
        nextCard: nextCardId ? cardsById[nextCardId] : null
      };
    } else {
      // Still has attempts left, don't bother updating the server or scheduler
      const nextAttempts = attempts + 1;
      console.log(`Attempt ${nextAttempts}/${MAX_ATTEMPTS} for card:`, currentCardId);
      setAttempts(nextAttempts);
      return {
        attempts: nextAttempts,
        nextCard: cardsById[currentCardId]
      };
    }
  };


  const value = {
    evaluationResult,
    error,
    attempts,
    showAnswer,
    currentCardId,
    cardsById,
    newCardsCount,
    learningCardsCount,
    reviewCardsCount,
    setEvaluationResult,
    setError,
    setAttempts,
    setShowAnswer,
    updateCardSchedulingServer,
    markIncorrectGetAttempts,
    markCorrectGetNext,
    cardSchedulerRef
  };

  return (
    <ReviewContext.Provider value={value}>
      {children}
    </ReviewContext.Provider>
  )
} 


export const useReview = () => {
  const context = useContext(ReviewContext);
  if (!context) {
    throw new Error('useDecks must be used within a DeckProvider');
  }
  return context;
}