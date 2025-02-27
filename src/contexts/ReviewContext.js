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

    // Store cards by ID for easy lookup - CONVERT TO REF
    const cardsByIdRef = useRef({});
    const currentCardIdRef = useRef(null);
    const [newCardsCount, setNewCardsCount] = useState(0);
    const [learningCardsCount, setLearningCardsCount] = useState(0);
    const [reviewCardsCount, setReviewCardsCount] = useState(0);

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

        // Build cards by ID map
        const newCardsById = {};
        deck.cards.forEach(card => {
            newCardsById[card.id] = JSON.parse(JSON.stringify(card));
        });
        cardsByIdRef.current = newCardsById;

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

    // We should sync the cards to the deck once we leave the review page. But not as important

    // Moving common logic into this method
    const updateCardSchedulingServer = async (cardId, quality) => {
        try {
            console.log(`🔄 Updating card ${cardId} with status: ${quality}`);

            if (!currentDeckId || !decks[currentDeckId]) {
                console.error('No deck selected');
                return null;
            }

            // Prepare card data, prioritizing cardsById for most current information
            const cardData = cardsByIdRef.current[cardId];

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
                cardsByIdRef.current[cardId].review = review;

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

    const markCorrectGetNext = async () => {
        if (!currentCardIdRef.current) return null;

        // Create a fresh copy of the card to avoid reference issues
        // First check if the card exists in cardsById
        const cardRaw = cardsByIdRef.current[currentCardIdRef.current];
        if (!cardRaw) {
            console.error('Card not found in cardsById:', currentCardIdRef.current);
            return null;
        }

        // Create a deep copy using JSON.parse/stringify to break any object references
        const card = JSON.parse(JSON.stringify(cardRaw));

        cardSchedulerRef.current.delete(currentCardIdRef.current);

        if (attempts > 0) {
            // If we've already tried this card, move it to learning state
            await updateCardSchedulingServer(currentCardIdRef.current, 'incorrect');

            const nextReviewTime = Date.now() + 10 * 60 * 1000;
            cardSchedulerRef.current.setReviewTime(currentCardIdRef.current, nextReviewTime, 'learning');
        } else {
            await updateCardSchedulingServer(currentCardIdRef.current, 'correct');
            if (!card.review || card.review.card_state === 'new') {
                // If it's a new card, move it to learning state

                const nextReviewTime = Date.now() + 10 * 60 * 1000;
                cardSchedulerRef.current.setReviewTime(currentCardIdRef.current, nextReviewTime, 'learning');
            } else {
                // First attempt success for review or learning card
                // Review card correct - remove from today's queue
            }
        }

        setAttempts(0);
        // Get next card
        const nextCardId = cardSchedulerRef.current.peekNext();

        setCurrentCardId(nextCardId);
        updateCardCounts();
        return nextCardId ? cardsByIdRef.current[nextCardId] : null;
    };

    const markIncorrectGetAttempts = async () => {
        if (!currentCardIdRef.current) return { attempts: 0, nextCard: null };

        if (attempts === 0) {
            // First incorrect attempt
            // Update card scheduling
            await updateCardSchedulingServer(currentCardIdRef.current, 'incorrect')

            // Update counts since we're changing the card state
            updateCardCounts();
        }

        if (attempts >= MAX_ATTEMPTS - 1) {
            // Max attempts reached - reschedule in learning state
            const nextReviewTime = Date.now() + 10 * 60 * 1000;
            cardSchedulerRef.current.delete(currentCardIdRef.current);
            cardSchedulerRef.current.setReviewTime(currentCardIdRef.current, nextReviewTime, 'learning');

            const nextCardId = cardSchedulerRef.current.peekNext();
            setCurrentCardId(nextCardId);
            setAttempts(0);
            updateCardCounts();
            return {
                attempts: 0,
                nextCard: nextCardId ? cardsByIdRef.current[nextCardId] : null
            };
        } else {
            // Still has attempts left, don't bother updating the server or scheduler
            const nextAttempts = attempts + 1;
            setAttempts(nextAttempts);
            return {
                attempts: nextAttempts,
                nextCard: cardsByIdRef.current[currentCardIdRef.current]
            };
        }
    };

    const value = {
        evaluationResult,
        error,
        attempts,
        showAnswer,
        currentCardId: currentCardIdRef.current, // Export the current value for consumers
        cardsById: cardsByIdRef.current, // Export the current value for consumers
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