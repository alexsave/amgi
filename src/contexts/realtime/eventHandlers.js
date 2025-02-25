export const handleAudioStarted = ({ mediaStreamRef }) => {
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = false;
        });
    }
};

export const handleAudioStopped = ({
    mediaStreamRef,
    onAudioStopped
}) => {
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = true;
        });
    }
    onAudioStopped();
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

export const handleCorrectResponse = async ({
    args,
    callId,
    markCorrectGetNext,
    setButtonState,
    realtimeTools
}) => {
    console.log('Correct response received');
    setButtonState('success');
    setTimeout(() => setButtonState('default'), 500);

    const nextCard = await markCorrectGetNext();
    if (nextCard) {
        console.log('Sending next card info', nextCard);
        realtimeTools.sendNextCardInfo(nextCard, false, callId, args.result, args.message);
    } else {
        console.log('Sending complete review');
        realtimeTools.sendCompleteReview(callId);
    }

    realtimeTools.requestNextResponse();
};

export const handleIncorrectResponse = ({
    args,
    callId,
    markIncorrectGetAttempts,
    setButtonState,
    realtimeTools,
}) => {
    setButtonState('error');
    setTimeout(() => setButtonState('default'), 500);

    const { attempts, nextCard } = markIncorrectGetAttempts();
    console.log('Next card', nextCard);

    realtimeTools.sendFunctionOutput(callId, {
        nextCard: nextCard ? {
            front_text: nextCard.front_text,
            back_text: nextCard.back_text
        } : null
    });

    realtimeTools.requestNextResponse();
};

export const handleMaxAttempts = ({
    callId,
    setShowAnswer,
    currentCardId,
    dueCards,
    moveToNextCard,
    realtimeTools
}) => {
    setShowAnswer(true);
    const currentIndex = dueCards.findIndex(card => card.id === currentCardId);
    const nextIndex = currentIndex + 1;
    const isLastCard = nextIndex >= dueCards.length;
    const nextCard = isLastCard ? null : dueCards[nextIndex];

    if (!isLastCard) {
        moveToNextCard();
    }

    realtimeTools.sendNextCardInfo(nextCard, isLastCard, callId, 'skip', 'Moving to next card after maximum attempts');
    if (isLastCard) {
        realtimeTools.sendCompleteReview();
    }
};

export const handleSkipResponse = ({
    args,
    callId,
    currentCardId,
    dueCards,
    updateCardScheduling,
    setShowAnswer,
    setShowSkip,
    moveToNextCard,
    realtimeTools
}) => {
    setShowSkip(true);
    setTimeout(() => setShowSkip(false), 500);
    updateCardScheduling(currentCardId, 'incorrect');
    setShowAnswer(true);

    const currentIndex = dueCards.findIndex(card => card.id === currentCardId);
    const nextIndex = currentIndex + 1;
    const isLastCard = nextIndex >= dueCards.length;
    const nextCard = isLastCard ? null : dueCards[nextIndex];

    if (!isLastCard) {
        moveToNextCard();
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
    currentCardId,
    dueCards,
    realtimeTools
}) => {
    const currentIndex = dueCards.findIndex(card => card.id === currentCardId);
    const nextIndex = currentIndex + 1;
    const nextCard = dueCards[nextIndex];

    realtimeTools.sendFunctionOutput(callId, nextCard ? {
        front_text: nextCard.front_text,
        back_text: nextCard.back_text,
        hasMore: nextIndex < dueCards.length - 1
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