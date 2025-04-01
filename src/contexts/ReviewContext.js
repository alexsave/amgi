import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { useDecks } from './DeckContext';
import { processCardReview } from '../algorithms/spacedRepetition';
import { CardScheduler } from '../utils/cardscheduler';
import { saveReview } from '../db/supabase';
import { useAuth } from './AuthContext';
import { getLocalDate, getEndOfDayTimestamp } from '../utils/dates';

const ReviewContext = createContext({});

// Interesting note: it works with 1 en->ko card. It works with 2 en->ko cads. After that idk
// Ok as long as you don't get anything wrong, it works with N en->ko cards.

// Ok simple failure exapmle. 1 en->ko card, 1 ko->en card. Get it down to 1 review card, get it wrong once, and it just ends right there
export const ReviewProvider = ({ children }) => {

    const MAX_ATTEMPTS = 3;

    const { currentDeckId, decks, updateDeckCards } = useDecks();
    const { user, isDirectMode } = useAuth();
    const [error, setError] = useState(null);
    const attemptsRef = useRef(0);
    const [attempts, setAttempts] = useState(0);

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
        const deck = decks[currentDeckId];
        if (!deck) {
            return;
        }

        console.log('Loading deck:', deck.name, 'with', deck.cards.length, 'cards');
        
        cardSchedulerRef.current.clear();

        let reviewCardsDebug = [];

        for (let i = 0; i < deck.cards.length; i++) {
            const card = deck.cards[i];
            if (!card.review) {
                cardSchedulerRef.current.pushNewCard(card);
            } else {
                cardSchedulerRef.current.setReview(card, card.review);
                if (card.review.card_state === 'review') {
                    reviewCardsDebug.push({
                        id: card.id,
                        next_review_date: card.review.next_review_date,
                        nextReviewTime: new Date(card.review.next_review_date).getTime(),
                        current_time: Date.now(),
                        endOfDayTime: new Date(getEndOfDayTimestamp()).getTime(),
                        isDue: new Date(card.review.next_review_date).getTime() <= new Date(getEndOfDayTimestamp()).getTime()
                    });
                }
            }
        }

        console.log('Review cards loaded:', reviewCardsDebug);
        if (reviewCardsDebug.length > 0) {
            console.log('Debug timestamps:',
                'Current time:', new Date().toISOString(),
                'End of day time:', getEndOfDayTimestamp(),
                'Current time (ms):', Date.now(),
                'End of day time (ms):', new Date(getEndOfDayTimestamp()).getTime()
            );
            console.log('Card scheduler stats:', 
                'Review cards in heap:', cardSchedulerRef.current.getReviewCardsCount(),
                'Review cards due today:', reviewCardsDebug.filter(c => c.isDue).length
            );
        }
        
        const nextCardId = cardSchedulerRef.current.peekNext();
        console.log('[Card Scheduler] Getting next card with ID:', nextCardId);
        const nextCard = cardSchedulerRef.current.getFullCard(nextCardId);

        // Update card counts since states might have changed
        updateCardCounts();

        currentCardIdRef.current = nextCardId;
        setCurrentCard(nextCard);

        console.log('[Card Scheduler] Initialized with cards:', {
            new: cardSchedulerRef.current.getNewCardsCount(),
            learning: cardSchedulerRef.current.getLearningCardsCount(),
            review: cardSchedulerRef.current.getReviewCardsCount()
        });
    }, [currentDeckId, decks]);

    // We should sync the cards to the deck once we leave the review page. But not as important

    // Function to sync cards back to the deck context
    const syncCardsToDeck = () => {
        if (!currentDeckId || !cardSchedulerRef.current) {
            return;
        }

        const updatedCards = Array.from(cardSchedulerRef.current.cardsMap.values());
        
        if (updatedCards.length > 0) {
            updateDeckCards(currentDeckId, updatedCards);
        }
    };

    // Function to save review data to the server without blocking 
    const saveReviewToServer = async (cardId, review) => {
        try {
            if (!user || isDirectMode) {
                return;
            }

            const today = getLocalDate();
            
            console.log('[Supabase] Saving review for card:', cardId, 'with state:', review.card_state);
            
            // Save to supabase without waiting for the response
            saveReview(cardId, {
                ...review,
                last_reviewed_at: new Date().toISOString(),
                scheduled_date: today
            }, user.id).catch(err => {
                console.error('[Supabase] Error saving review to server:', err);
            });
        } catch (error) {
            console.error('Error in saveReviewToServer:', error);
        }
    };

    // Process card review and update scheduler
    const processCardOutcome = (cardId, outcome) => {
        try {
            // Get the card from the scheduler
            console.log('[Card Scheduler] Getting card details for ID:', cardId);
            const card = cardSchedulerRef.current.getFullCard(cardId);
            
            if (!card) {
                console.error('[Card Scheduler] Card not found in CardScheduler:', cardId);
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
        console.log('[Card Scheduler] Processing correct answer for card:', cardId);

        // Process the card as correct
        const { nextCard, resetAttempts } = processCardOutcome(cardId, 'correct');

        // Update the current card info
        if (resetAttempts) {
            attemptsRef.current = 0;
            setAttempts(0);
        }

        currentCardIdRef.current = nextCard?.id || null;
        setCurrentCard(nextCard);
        console.log('[Card Scheduler] Moving to next card:', nextCard?.id || 'No more cards');

        return nextCard;
    };

    const markIncorrectGetNext = () => {
        if (!currentCardIdRef.current) return null;
        
        const cardId = currentCardIdRef.current;
        console.log('[Card Scheduler] Processing incorrect answer for card:', cardId);

        // Process the card as incorrect
        const { nextCard, resetAttempts } = processCardOutcome(cardId, 'incorrect');

        // If we should reset attempts, move to the next card
        if (resetAttempts) {
            currentCardIdRef.current = nextCard?.id || null;
            setCurrentCard(nextCard);
            attemptsRef.current = 0;
            setAttempts(0);
            console.log('[Card Scheduler] Moving to next card after max attempts:', nextCard?.id || 'No more cards');
            
            return nextCard;
        } else {
            // Otherwise, increment attempts and keep the same card
            attemptsRef.current += 1;
            setAttempts(attemptsRef.current);
            console.log('[Card Scheduler] Keeping same card, attempts increased to:', attemptsRef.current);
            
            return nextCard;
        }
    };

    const value = {
        error,
        attempts,
        currentCardId: currentCardIdRef.current, // Export the current value for consumers
        newCardsCount,
        learningCardsCount,
        reviewCardsCount,
        setError,
        setAttempts,
        markIncorrectGetNext,
        markCorrectGetNext,
        currentCard,
        cardSchedulerRef,
        currentCardIdRef,
        syncCardsToDeck
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