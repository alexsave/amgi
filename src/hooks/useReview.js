import { useState, useEffect, useRef } from 'react';
import { useDecks } from '../contexts/DeckContext';
import { calculateNextReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';
import * as supabase from '../db/supabase';
import { useAuth } from '../contexts/AuthContext';
import { getLocalDate, parseLocalDate } from '../utils/dates';

// this could probalby be it's own context
export function useReview() {

  const MAX_ATTEMPTS = 3;

  const { currentDeckId, decks, mode } = useDecks();
  const { user, isDirectMode } = useAuth();
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [error, setError] = useState(null);
  // Attempts of the current card. I guess we can keep this
  const [attempts, setAttempts] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  //const [dueCards, setDueCards] = useState([]);

  const [currentCard, setCurrentCard] = useState(null);
  const [newCardsCount, setNewCardsCount] = useState(0);
  const [reviewCardsCount, setReviewCardsCount] = useState(0);

  const cardSchedulerRef = useRef(new CardScheduler());

  // Update card counts whenever the scheduler changes
  const updateCardCounts = () => {
    setNewCardsCount(cardSchedulerRef.current.getNewCardsCount());
    setReviewCardsCount(cardSchedulerRef.current.getReviewCardsCount());
  };

  // Copy currentDeck into priority queue so we don't mess with the original deck
  // Holy fuck DeckContext is so complicated now
  useEffect(() => {
    console.log('useReview useEffect called with currentDeckId:' + currentDeckId + ' and mode:' + mode);
    if (!currentDeckId || mode !== 'review') {
      return;
    }

    const deck = decks[currentDeckId];
    if (!deck) return;

    cardSchedulerRef.current.clear();
    const now = new Date();
    console.log('Deck:' + JSON.stringify(deck));

    for (let i = 0; i < deck.cards.length; i++) {
      const card = deck.cards[i];
      console.log('Card:' + JSON.stringify(card));
      if (card.nextReview == null) {
        // New card. Setting it to i preserves the order of new cards
        cardSchedulerRef.current.pushNewCard(card);
      } else {
        if (card.dueTimestamp && card.dueTimestamp < now) {
          cardSchedulerRef.current.setReviewTime(card.id, card.dueTimestamp);
        }
      }
    }
    console.log('CardScheduler after setup:' + JSON.stringify(cardSchedulerRef.current));
    console.log('setting current card to ' + JSON.stringify(cardSchedulerRef.current.peekNext()));
    setCurrentCard(cardSchedulerRef.current.peekNext());
    updateCardCounts();
  }, [currentDeckId]);

  // Get due cards
  const getDueCards = (deckId) => {
    const deck = decks[deckId];
    if (!deck) return [];

    const now = new Date();

    // Separate new and review cards
    const newCards = deck.cards.filter(card => !card.lastReviewed);
    const reviewCards = deck.cards.filter(card => {
      if (!card.lastReviewed) return false;

      // If the card has a due timestamp (for cards due in minutes), check against that
      if (card.dueTimestamp) {
        return new Date(card.dueTimestamp) <= now;
      }

      // Check against next review timestamp
      if (!card.nextReview) return false;
      return new Date(card.nextReview) <= now;
    });

    // Sort review cards by due date/timestamp
    const sortedReviewCards = [...reviewCards].sort((a, b) => {
      const aTime = a.dueTimestamp ? new Date(a.dueTimestamp) : new Date(a.nextReview);
      const bTime = b.dueTimestamp ? new Date(b.dueTimestamp) : new Date(b.nextReview);
      return aTime - bTime;
    });

    // Return new cards first (in original order), then review cards (sorted by due time)
    return [...newCards, ...sortedReviewCards];
  };

  const updateCardSchedulingServer = async (cardId, quality) => {
    console.log('Updating card scheduling for card ' + cardId + ' with quality ' + quality);
    try {
      if (!currentDeckId || !decks[currentDeckId]) {
        throw new Error('No deck selected');
      }

      const deck = decks[currentDeckId];
      const cardIndex = deck.cards.findIndex(c => c.id === cardId);
      if (cardIndex === -1) {
        throw new Error('Card not found');
      }

      const card = deck.cards[cardIndex];
      const { interval, easeFactor, repetitions, nextReview } = calculateNextReview(
        card.interval || 0,
        card.easeFactor || 2.5,
        card.repetitions || 0,
        quality
      );

      console.log('Updating card scheduling for card ' + cardId + ' with interval ' + interval + ' and easeFactor ' + easeFactor + ' and repetitions ' + repetitions + ' and nextReview ' + nextReview);

      // Update the review in Supabase if we're not in direct mode
      if (user && !isDirectMode) {
        const today = getLocalDate();
        
        // For incorrect responses or new cards that were incorrect,
        // set next_review_date to today so they stay in the review queue
        const next_review_date = quality === 'incorrect' ? 
          today : 
          getLocalDate(nextReview);

        console.log('Saving review for card ' + cardId + ' with interval ' + interval + ' and easeFactor ' + easeFactor + ' and repetitions ' + repetitions + ' and next_review_date ' + next_review_date);
        await supabase.saveReview(cardId, {
          interval_days: interval,
          ease_factor: easeFactor,
          repetitions,
          next_review_date: next_review_date,
          last_reviewed_at: new Date().toISOString(),
          scheduled_date: today
        }, user.id);
      }

      // Update the local scheduler
      //cardSchedulerRef.current.setReviewTime(card, nextReview);
      setError(null);
    } catch (err) {
      console.error('Error updating card scheduling:', err);
      setError('Failed to update card scheduling');
    }
  };

  const markCorrectGetNext = () => {
    console.log('=== markCorrectGetNext ===');
    console.log('Current time:', new Date().toISOString());
    console.log('Current card:', currentCard);
    console.log('Current attempts:', attempts);

    if (attempts === 0) {
      console.log('First attempt success - updating server and removing from scheduler');
      updateCardSchedulingServer(currentCard.id, 'correct');
      cardSchedulerRef.current.delete(currentCard.id);
      console.log('Card deleted from scheduler');
    } else {
      console.log(`Success after ${attempts} attempts - scheduling review in 10 minutes`);
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      console.log('Next review time:', new Date(nextReviewTime).toISOString());
      cardSchedulerRef.current.setReviewTime(currentCard, nextReviewTime);
    }

    console.log('Resetting attempts counter to 0');
    setAttempts(0);

    const nextCard = cardSchedulerRef.current.peekNext();
    console.log('Next card from scheduler:', nextCard);
    setCurrentCard(nextCard);
    updateCardCounts();
    console.log('Updated card counts');
    console.log('=== End markCorrectGetNext ===');
    return nextCard;
  }


  const markIncorrectGetAttempts = () => {
    console.log('=== markIncorrectGetAttempts ===');
    console.log('Current time:', new Date().toISOString());
    console.log('Current card:', currentCard);
    console.log('Current attempts:', attempts);
    console.log('Max attempts:', MAX_ATTEMPTS);

    if (attempts === 0) {
      console.log('First incorrect attempt - updating server');
      updateCardSchedulingServer(currentCard.id, 'incorrect');
    }  
    
    if (attempts >= MAX_ATTEMPTS-1) {
      console.log('Max attempts reached - scheduling review in 10 minutes');
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      console.log('Next review time:', new Date(nextReviewTime).toISOString());
      cardSchedulerRef.current.setReviewTime(currentCard, nextReviewTime);

      const nextCard = cardSchedulerRef.current.peekNext();
      console.log('Moving to next card:', nextCard);
      setCurrentCard(nextCard);
      console.log('Resetting attempts to 0');
      setAttempts(0);
      updateCardCounts();
      console.log('Updated card counts');
      console.log('=== End markIncorrectGetAttempts ===');
      return {
        attempts: 0,
        nextCard: nextCard
      };
    } else {
      const nextAttempts = attempts + 1;
      console.log(`Incrementing attempts to ${nextAttempts}`);
      setAttempts(nextAttempts);
      console.log('Keeping same card for next attempt');
      console.log('=== End markIncorrectGetAttempts ===');
      return {
        attempts: nextAttempts,
        nextCard: currentCard
      };
    }
  }

  return {
    evaluationResult,
    error,
    attempts,
    showAnswer,
    setEvaluationResult,
    setError,
    setAttempts,
    setShowAnswer,
    updateCardSchedulingServer,
    currentCard,
    markIncorrectGetAttempts,
    markCorrectGetNext,
    cardSchedulerRef,
    newCardsCount,
    reviewCardsCount
  };
} 