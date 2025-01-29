import { useState, useEffect } from 'react';
import { useDecks } from '../contexts/DeckContext';
import { calculateNextReview } from '../algorithms/spacedRepetition';

export function useReview() {
  const { currentDeck, decks, updateCard } = useDecks();
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [dueCards, setDueCards] = useState([]);

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
      if (!currentDeck || !decks[currentDeck]) {
        throw new Error('No deck selected');
      }

      const deck = decks[currentDeck];
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

      updateCard(currentDeck, cardId, {
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

  // Update due cards more frequently to catch cards becoming due
  useEffect(() => {
    if (currentDeck) {
      const updateDueCards = () => {
        const due = getDueCards(currentDeck);
        setDueCards(due);
      };

      // Initial update
      updateDueCards();

      // Check for due cards every minute
      const interval = setInterval(updateDueCards, 60000);
      return () => clearInterval(interval);
    }
  }, [currentDeck, decks]);

  // Reset attempts when moving to a new card
  useEffect(() => {
    setAttempts(0);
    setShowAnswer(false);
    setEvaluationResult(null);
  }, [currentCardIndex]);

  const moveToNextCard = () => {
    setCurrentCardIndex(prev => prev + 1);
    if (currentCardIndex < dueCards.length - 1) {
      setEvaluationResult(null);
      setAttempts(0);
      setShowAnswer(false);
    }
  };

  return {
    currentCardIndex,
    evaluationResult,
    error,
    attempts,
    showAnswer,
    dueCards,
    setCurrentCardIndex,
    setEvaluationResult,
    setError,
    setAttempts,
    setShowAnswer,
    updateCardScheduling,
    moveToNextCard
  };
} 