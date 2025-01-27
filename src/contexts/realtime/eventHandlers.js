import { logRealtimeEvent } from './webrtc';

export const handleAudioStarted = ({ mediaStreamRef }) => {
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = false;
        });
    }
};

export const handleAudioStopped = ({
    mediaStreamRef,
    peerConnectionRef,
    setIsConnected,
    hasActiveResponse,
    review
}) => {
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = true;
        });
    }
    // If we're in a completed state and the AI just finished speaking, clean up
    if (!hasActiveResponse && review.currentCardIndex >= review.dueCards.length - 1) {
        setTimeout(() => {
            if (mediaStreamRef.current) {
                mediaStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
            setIsConnected(false);
        }, 500);
    }
};

export const handleTextDelta = ({
    event,
    setIsSpeaking,
    setHasActiveResponse,
    setFeedback,
    isRecording,
    setIsRecording,
    animationFrameRef,
    setAudioScale
}) => {
    setIsSpeaking(true);
    setHasActiveResponse(true);
    setFeedback(prev => prev + event.delta);
    // Stop recording if we were recording when AI starts speaking
    if (isRecording) {
        setIsRecording(false);
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }
        setAudioScale(0);
    }
    // Clear any previous timeout
    if (window.speakingTimeoutId) {
        clearTimeout(window.speakingTimeoutId);
    }
    // Set a timeout to mark speaking as done if no new delta arrives
    window.speakingTimeoutId = setTimeout(() => {
        setIsSpeaking(false);
    }, 500);
};

export const handleCorrectResponse = ({
    args,
    callId,
    review,
    currentCard,
    setButtonState,
    realtimeTools
}) => {
    setButtonState('success');
    setTimeout(() => setButtonState('default'), 500);
    review.updateCardScheduling(currentCard.created, 'correct');

    const nextIndex = review.currentCardIndex + 1;
    const isLastCard = nextIndex >= review.dueCards.length;
    const nextCard = isLastCard ? null : review.dueCards[nextIndex];

    if (!isLastCard) {
        review.moveToNextCard();
    }

    realtimeTools.sendNextCardInfo(nextCard, isLastCard, callId, args.result, args.message);
    if (isLastCard) {
        realtimeTools.sendCompleteReview();
    }
    realtimeTools.requestNextResponse();
};

export const handleIncorrectResponse = ({
    args,
    callId,
    review,
    currentCard,
    setButtonState,
    realtimeTools,
    handleMaxAttempts
}) => {
    setButtonState('error');
    setTimeout(() => setButtonState('default'), 500);
    review.updateCardScheduling(currentCard.created, 'incorrect');

    let shouldMoveToNext = false;
    review.setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
            shouldMoveToNext = true;
        }
        return newAttempts;
    });

    if (shouldMoveToNext) {
        handleMaxAttempts(callId, review);
    } else {
        realtimeTools.sendFunctionOutput(callId, {
            result: args.result,
            message: args.message
        });
    }
    realtimeTools.requestNextResponse();
};

export const handleMaxAttempts = ({
    callId,
    review,
    realtimeTools
}) => {
    review.setShowAnswer(true);
    const nextIndex = review.currentCardIndex + 1;
    const isLastCard = nextIndex >= review.dueCards.length;
    const nextCard = isLastCard ? null : review.dueCards[nextIndex];

    if (!isLastCard) {
        review.moveToNextCard();
    }

    realtimeTools.sendNextCardInfo(nextCard, isLastCard, callId, 'skip', 'Moving to next card after maximum attempts');
    if (isLastCard) {
        realtimeTools.sendCompleteReview();
    }
};

export const handleSkipResponse = ({
    args,
    callId,
    review,
    currentCard,
    setShowSkip,
    realtimeTools
}) => {
    setShowSkip(true);
    setTimeout(() => setShowSkip(false), 500);
    review.updateCardScheduling(currentCard.created, 'incorrect');
    review.setShowAnswer(true);

    const nextIndex = review.currentCardIndex + 1;
    const isLastCard = nextIndex >= review.dueCards.length;
    const nextCard = isLastCard ? null : review.dueCards[nextIndex];

    if (!isLastCard) {
        review.moveToNextCard();
    }

    realtimeTools.sendNextCardInfo(nextCard, isLastCard, callId, args.result, args.message);
    if (isLastCard) {
        realtimeTools.sendCompleteReview();
    }
    realtimeTools.requestNextResponse();
};

export const handleAgainResponse = ({
    args,
    callId,
    realtimeTools
}) => {
    realtimeTools.sendFunctionOutput(callId, {
        result: args.result,
        message: args.message
    });
    realtimeTools.requestNextResponse();
};

export const handleGetNextCard = ({
    callId,
    review,
    realtimeTools
}) => {
    const nextCardIndex = review.currentCardIndex + 1;
    const nextCard = review.dueCards[nextCardIndex];

    realtimeTools.sendFunctionOutput(callId, nextCard ? {
        frontText: nextCard.frontText,
        backText: nextCard.backText,
        hasMore: nextCardIndex < review.dueCards.length - 1
    } : null);
    realtimeTools.requestNextResponse();
};

export const handleCompleteReviewFunction = ({
    args,
    callId,
    setFeedback,
    realtimeTools
}) => {
    setFeedback(args.message);
    realtimeTools.sendFunctionOutput(callId, { success: true });
    realtimeTools.requestNextResponse();
};

export const handleCardCorrect = (review, currentCard) => {
  review.markCardCorrect(currentCard);
};

export const handleCardIncorrect = (review, currentCard) => {
  review.markCardIncorrect(currentCard);
};

export const handleSkip = (review) => {
  review.skipCard();
};

export const handleQuit = (review) => {
  review.endReview();
}; 