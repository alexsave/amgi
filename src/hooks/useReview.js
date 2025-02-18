import { useState, useEffect, useRef } from 'react';
import { useDecks } from '../contexts/DeckContext';
import { calculateNextReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';

// this could probalby be it's own context
export function useReview() {

  const MAX_ATTEMPTS = 3;

  const { currentDeckId, decks, updateCard, mode } = useDecks();
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [error, setError] = useState(null);
  // Attempts of the current card. I guess we can keep this
  const [attempts, setAttempts] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  //const [dueCards, setDueCards] = useState([]);

  const [currentCard, setCurrentCard] = useState(null);

  const cardSchedulerRef = useRef(new CardScheduler());


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
          cardSchedulerRef.current.pushReviewCard(card);
        }
      }
    }
    console.log('CardScheduler after setup:' + JSON.stringify(cardSchedulerRef.current));
    console.log('setting current card to ' + JSON.stringify(cardSchedulerRef.current.peekNext()));
    setCurrentCard(cardSchedulerRef.current.peekNext());
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

  const updateCardScheduling = (cardId, quality) => {
    try {
      if (!currentDeckId || !decks[currentDeckId]) {
        throw new Error('No deck selected');
      }

      const deck = decks[currentDeckId];
      const cardIndex = deck.cards.findIndex(c => c.created === cardId);
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

      updateCard(currentDeckId, cardId, {
        interval,
        easeFactor,
        repetitions,
        nextReview,
        lastReviewed: Date.now()
      });

      setError(null);
    } catch (err) {
      console.error('Error updating card scheduling:', err);
      setError('Failed to update card scheduling');
    }
  };

  const markIncorrectGetAttempts = () => {
    if (attempts >= MAX_ATTEMPTS-1) {
      const nextCard = cardSchedulerRef.current.peekNext();
      // This needs to be pushed 10 minutes in the future
      cardSchedulerRef.current.setReviewTime(currentCard, Date.now() + 10 * 60 * 1000);
      console.log('setting current card to ' + nextCard);
      setCurrentCard(nextCard);
      setAttempts(0);
      return {
        attempts: 0,
        nextCard: nextCard
      };
    } else {
      setAttempts(prev => prev + 1);
      return {
        attempts: attempts+1,
        nextCard: currentCard
      };
    }
  }

  const markCorrectGetNext = () => {
    console.log('calling markCorrectGetNext at ' + Date.now());
    if (attempts > 0) {
      // They got it wrong previously, so we need to push the card 10 minutes in the future
      cardSchedulerRef.current.setReviewTime(currentCard, Date.now() + 10 * 60 * 1000);
    }
    setAttempts(0);
    cardSchedulerRef.current.popNext();
    const nextCard = cardSchedulerRef.current.peekNext();
    console.log('markCorrectGetNext: nextCard:', nextCard);
    console.log('setting current card to ' + nextCard);
    setCurrentCard(nextCard);
    return nextCard;
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
    updateCardScheduling,
    currentCard,
    markIncorrectGetAttempts,
    markCorrectGetNext,
    cardSchedulerRef
  };
} 