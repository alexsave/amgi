import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { useDecks } from './DeckContext';
import { processCardReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';
import { saveReview } from '../db/supabase';
import { useAuth } from './AuthContext';
import { getLocalDate } from '../utils/dates';

const ReviewContext = createContext({});

// Interesting note: it works with 1 en->ko card. It works with 2 en->ko cads. After that idk
// Ok as long as you don't get anything wrong, it works with N en->ko cards.

// Ok simple failure exapmle. 1 en->ko card, 1 ko->en card. Get it down to 1 review card, get it wrong once, and it just ends right there
export const ReviewProvider = ({ children }) => {

    const MAX_ATTEMPTS = 3;

    const location = useLocation();
    const { currentDeckId, decks } = useDecks();
    const { user, isDirectMode } = useAuth();
    const [evaluationResult, setEvaluationResult] = useState(null);
    const [error, setError] = useState(null);
    const attemptsRef = useRef(0);
    const [attempts, setAttempts] = useState(0);
    const [showAnswer, setShowAnswer] = useState(false);

    // Store the current card ID reference
    const currentCardIdRef = useRef(null);
    const [newCardsCount, setNewCardsCount] = useState(0);
    const [learningCardsCount, setLearningCardsCount] = useState(0);
    const [reviewCardsCount, setReviewCardsCount] = useState(0);

    const [currentCard, setCurrentCard] = useState(null);

    // CardScheduler is the single source of truth for all card data
    const cardSchedulerRef = useRef(new CardScheduler());

    // Update card counts whenever the scheduler changes
    const updateCardCounts = () => {
        setNewCardsCount(cardSchedulerRef.current.getNewCardsCount());
        setLearningCardsCount(cardSchedulerRef.current.getLearningCardsCount());
        setReviewCardsCount(cardSchedulerRef.current.getReviewCardsCount());
    };

    // Initialize scheduler with deck cards
    useEffect(() => {
        //const isReviewMode = location.pathname.includes('/review');
        //if (!currentDeckId || !isReviewMode) {
            //console.log('ReviewContext: useEffect: not in review mode');
            //return;
        //}

        const deck = decks[currentDeckId];
        if (!deck) {
            return;
        }

        cardSchedulerRef.current.clear();

        for (let i = 0; i < deck.cards.length; i++) {
            const card = deck.cards[i];
            if (!card.review) {
                cardSchedulerRef.current.pushNewCard(card);
            } else {
                cardSchedulerRef.current.setReview(card, card.review);
            }
        }
        const nextCardId = cardSchedulerRef.current.peekNext();
        currentCardIdRef.current = nextCardId;
        setCurrentCard(cardSchedulerRef.current.getFullCard(nextCardId));
        updateCardCounts();
    }, [currentDeckId ]);

    // We should sync the cards to the deck once we leave the review page. But not as important

    // Function to save review data to the server without blocking 
    const saveReviewToServer = async (cardId, review) => {
        try {
            if (!user || isDirectMode) {
                return;
            }

            const today = getLocalDate();
            
            // Save to supabase without waiting for the response
            saveReview(cardId, {
                ...review,
                last_reviewed_at: new Date().toISOString(),
                scheduled_date: today
            }, user.id).catch(err => {
                console.error('Error saving review to server:', err);
            });
        } catch (error) {
            console.error('Error in saveReviewToServer:', error);
        }
    };

    // Process card review and update scheduler
    const processCardOutcome = (cardId, outcome) => {
        try {
            // Get the card from the scheduler
            const card = cardSchedulerRef.current.getFullCard(cardId);
            
            if (!card) {
                console.error('Card not found in CardScheduler:', cardId);
                return {
                    nextCard: null,
                    resetAttempts: true
                };
            }
            
            // Process the review outcome with the card's current state and attempt count
            const review = processCardReview(card, outcome, attemptsRef.current, MAX_ATTEMPTS);
            let nextCard = null;

            if (review.shouldGoToNextCard) {

                // First remove the card from the scheduler
                cardSchedulerRef.current.delete(cardId);

                // Now handle based on whether we should reschedule
                if (review.shouldReschedule) {
                    // Cards that need to be rescheduled:
                    // - All learning cards
                    // - Cards that were answered incorrectly
                    // Use setReview to update the card data and put it in the right queue
                    cardSchedulerRef.current.setReview(card, review);
                }
                // Otherwise, the card is done and we don't need to do anything. 
                // If it goes to review, it will be loaded again no sooner than tomorrow

                // Asynchronously save to server without blocking
                saveReviewToServer(cardId, review);

                // Get the next card
                const nextCardId = cardSchedulerRef.current.peekNext();
                nextCard = cardSchedulerRef.current.getFullCard(nextCardId);

                // Update card counts since states might have changed
                updateCardCounts();
            } else {
                /// Don't touch the scheduler. Just keep the same card.
                nextCard = card;
            }


            return {
                nextCard,
                resetAttempts: review.resetAttempts
            };
        } catch (error) {
            console.error('Error processing card outcome:', error);
            setError('Failed to update card scheduling');
            return {
                nextCard: null,
                resetAttempts: true
            };
        }
    };

    const markCorrectGetNext = () => {
        if (!currentCardIdRef.current) return null;

        const cardId = currentCardIdRef.current;

        // Process the card as correct
        const { nextCard, resetAttempts } = processCardOutcome(cardId, 'correct');

        // Update the current card info
        if (resetAttempts) {
            attemptsRef.current = 0;
            setAttempts(0);
        }

        currentCardIdRef.current = nextCard?.id || null;
        setCurrentCard(nextCard);

        return nextCard;
    };

    const markIncorrectGetNext = () => {
        if (!currentCardIdRef.current) return null;

        const cardId = currentCardIdRef.current;

        // Process the card as incorrect
        const { nextCard, resetAttempts } = processCardOutcome(cardId, 'incorrect');

        // If we should reset attempts, move to the next card
        if (resetAttempts) {
            currentCardIdRef.current = nextCard?.id || null;
            setCurrentCard(nextCard);
            attemptsRef.current = 0;
            setAttempts(0);
            return nextCard;
        } else {
            // Otherwise, increment attempts and keep the same card
            attemptsRef.current += 1;
            setAttempts(attemptsRef.current);
            return nextCard;
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
        markIncorrectGetNext,
        markCorrectGetNext,
        currentCard,
        cardSchedulerRef,
        currentCardIdRef
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