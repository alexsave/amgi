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

  // Initialize scheduler with deck cards
  useEffect(() => {
    console.log('useReview useEffect called with currentDeckId:' + currentDeckId + ' and mode:' + mode);
    if (!currentDeckId || mode !== 'review') {
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
  }, [currentDeckId]);

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
      const currentState = card.review?.card_state || 'new';
      const currentRepetitions = card.review?.repetitions || 0;

      // Calculate next interval and ease factor
      const { interval, easeFactor, repetitions, nextReview } = calculateNextReview(
        card.review?.interval_days || 0,
        card.review?.ease_factor || 2.5,
        currentRepetitions,
        quality
      );

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

      setError(null);
    } catch (err) {
      console.error('Error updating card scheduling:', err);
      setError('Failed to update card scheduling');
    }
  };

  const markCorrectGetNext = () => {
    if (!currentCardId) return null;

    if (attempts === 0) {
      // First attempt success
      const card = cardsById[currentCardId];

      if (!card.review || card.review.card_state === 'new') {
        // New card correct - move to learning state with 10 minute delay
        const nextReviewTime = Date.now() + 10 * 60 * 1000;
        cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');
        updateCardSchedulingServer(currentCardId, 'incorrect');
      } else {
        // Review card correct - remove from today's queue
        updateCardSchedulingServer(currentCardId, 'correct');
        cardSchedulerRef.current.delete(currentCardId);
      }
    } else {
      // Success after multiple attempts - keep in learning state
      updateCardSchedulingServer(currentCardId, 'incorrect');
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');
    }

    setAttempts(0);
    const nextCardId = cardSchedulerRef.current.peekNext();
    setCurrentCardId(nextCardId);
    updateCardCounts();
    return nextCardId;
  };

  const markIncorrectGetAttempts = () => {
    if (!currentCardId) return { attempts: 0, nextCard: null };

    if (attempts === 0) {
      // First incorrect attempt
      updateCardSchedulingServer(currentCardId, 'incorrect');
    }

    if (attempts >= MAX_ATTEMPTS - 1) {
      // Max attempts reached - reschedule in learning state
      const nextReviewTime = Date.now() + 10 * 60 * 1000;
      cardSchedulerRef.current.setReviewTime(currentCardId, nextReviewTime, 'learning');

      const nextCardId = cardSchedulerRef.current.peekNext();
      setCurrentCardId(nextCardId);
      setAttempts(0);
      updateCardCounts();
      return {
        attempts: 0,
        nextCard: nextCardId
      };
    } else {
      // Still has attempts left
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);
      return {
        attempts: nextAttempts,
        nextCard: currentCardId
      };
    }
  };

  return {
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
} 