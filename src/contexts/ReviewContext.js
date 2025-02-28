import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { useDecks } from './DeckContext';
import { calculateNextReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';
import * as supabase from '../db/supabase';
import { useAuth } from './AuthContext';
import { getLocalDate } from '../utils/dates';

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

    // Store the current card ID reference
    const currentCardIdRef = useRef(null);
    const [newCardsCount, setNewCardsCount] = useState(0);
    const [learningCardsCount, setLearningCardsCount] = useState(0);
    const [reviewCardsCount, setReviewCardsCount] = useState(0);

    // CardScheduler is the single source of truth for all card data
    const cardSchedulerRef = useRef(new CardScheduler());

    // Helper function to set the current card ID
    const setCurrentCardId = (cardId) => {
        currentCardIdRef.current = cardId;
    };

    // Update card counts whenever the scheduler changes
    const updateCardCounts = () => {
        setNewCardsCount(cardSchedulerRef.current.getNewCardsCount());
        setLearningCardsCount(cardSchedulerRef.current.getLearningCardsCount());
        setReviewCardsCount(cardSchedulerRef.current.getReviewCardsCount());
    };

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

        for (let i = 0; i < deck.cards.length; i++) {
            const card = deck.cards[i];

            if (!card.review) {
                cardSchedulerRef.current.pushNewCard(card);
            } else {
                const reviewTime = card.review.next_review_date ? new Date(card.review.next_review_date).getTime() : now.getTime();
                cardSchedulerRef.current.setReviewTime(
                    card,
                    reviewTime,
                    card.review.card_state
                );
            }
        }
        currentCardIdRef.current = cardSchedulerRef.current.peekNext();
        updateCardCounts();
    }, [currentDeckId, decks, location]);

    // We should sync the cards to the deck once we leave the review page. But not as important

    // Moving common logic into this method
    const updateCardSchedulingServer = async (cardId, quality) => {
        try {
            console.log(`🔄 Updating card ${cardId} with status: ${quality}`);

            if (!currentDeckId || !decks[currentDeckId]) {
                console.error('No deck selected');
                return null;
            }

            // Get the card from the scheduler, which is now our single source of truth
            const cardData = cardSchedulerRef.current.getFullCard(cardId);

            if (!cardData) {
                console.error('❌ Card not found in CardScheduler:', cardId);
                return null;
            }

            // This is the only point where we actually need review to be in cardData. 
            // If we can move this to the scheduler, that would make it the single source of truth
            const { interval, easeFactor, repetitions, nextReview, cardState } = calculateNextReview(cardData.review, quality);


            // Better idea: update the scheduler first then updat the review in supabase without blocking anythign

            // Update the review in Supabase if we're not in direct mode
            if (user && !isDirectMode) {
                const today = getLocalDate();

                const review = await supabase.saveReview(cardId, {
                    interval_days: interval,
                    ease_factor: easeFactor,
                    repetitions,
                    next_review_date: nextReview,
                    last_reviewed_at: new Date().toISOString(),
                    scheduled_date: today,
                    card_state: cardState
                }, user.id);

                console.log('After update - Card:', cardId, 'New state:', review.card_state);

                // Update the card in the scheduler
                cardSchedulerRef.current.setReview(cardId, review); 

                return review;
            }

            setError(null);
        } catch (error) {
            console.error('Error updating card scheduling:', error);
            setError('Failed to update card scheduling');
            return null;
        }
    };

    const markCorrectGetNext = async () => {
        if (!currentCardIdRef.current) return null;

        // Get the card from the scheduler
        const cardId = currentCardIdRef.current;
        const card = cardSchedulerRef.current.getFullCard(cardId);
        
        if (!card) {
            console.error('Card not found in CardScheduler:', cardId);
            return null;
        }

        cardSchedulerRef.current.delete(cardId);

        if (attempts > 0) {
            // If we've already tried this card, move it to learning state
            await updateCardSchedulingServer(cardId, 'incorrect');

            const nextReviewTime = Date.now() + 10 * 60 * 1000;
            cardSchedulerRef.current.setReviewTime(cardId, nextReviewTime, 'learning');
        } else {
            const cardState = cardSchedulerRef.current.getCardState(cardId);
            await updateCardSchedulingServer(cardId, 'correct');
            if (cardState === 'new') {
                // If it's a new card, move it to learning state
                const nextReviewTime = Date.now() + 10 * 60 * 1000;
                cardSchedulerRef.current.setReviewTime(cardId, nextReviewTime, 'learning');
            } else {
                // First attempt success for review or learning card
                // Review card correct - remove from today's queue
            }
        }

        setAttempts(0);
        // Get next card ID
        const nextCardId = cardSchedulerRef.current.peekNext();

        setCurrentCardId(nextCardId);
        updateCardCounts();
        return nextCardId ? cardSchedulerRef.current.getFullCard(nextCardId) : null;
    };

    const markIncorrectGetAttempts = async () => {
        if (!currentCardIdRef.current) return { attempts: 0, nextCard: null };

        const cardId = currentCardIdRef.current;

        if (attempts === 0) {
            // First incorrect attempt
            // Update card scheduling
            await updateCardSchedulingServer(cardId, 'incorrect');

            // Update counts since we're changing the card state
            updateCardCounts();
        }

        if (attempts >= MAX_ATTEMPTS - 1) {
            // Max attempts reached - reschedule in learning state
            const nextReviewTime = Date.now() + 10 * 60 * 1000;
            // Iffy on this part
            const updatedCard = cardSchedulerRef.current.getFullCard(cardId);
            cardSchedulerRef.current.delete(cardId);
            
            if (updatedCard) {
                cardSchedulerRef.current.setReviewTime(updatedCard, nextReviewTime, 'learning');
            }

            const nextCardId = cardSchedulerRef.current.peekNext();
            currentCardIdRef.current = nextCardId;
            setAttempts(0);
            updateCardCounts();
            return {
                attempts: 0,
                nextCard: nextCardId ? cardSchedulerRef.current.getFullCard(nextCardId) : null
            };
        } else {
            // Still has attempts left, don't bother updating the server or scheduler
            const nextAttempts = attempts + 1;
            setAttempts(nextAttempts);
            return {
                attempts: nextAttempts,
                nextCard: cardSchedulerRef.current.getFullCard(cardId)
            };
        }
    };

    const value = {
        evaluationResult,
        error,
        attempts,
        showAnswer,
        currentCardId: currentCardIdRef.current, // Export the current value for consumers
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
        throw new Error('useReview must be used within a ReviewProvider');
    }
    return context;
}