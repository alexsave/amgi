import { useState } from 'react';

export const useRealtimeAPI = (mediaStreamRef, hasActiveResponse, review, peerConnectionRef, setIsConnected, setHasStarted, setIsSpeaking, setHasActiveResponse, setFeedback, isRecording, setIsRecording, animationFrameRef, setAudioScale, setButtonState, currentCard, dataChannelRef) => {
    const [showSkip, setShowSkip] = useState(false);

    const sessionTools = {
        evaluatePronunciation: {
            type: 'function',
            name: 'evaluatePronunciation',
            description: 'Evaluate the pronunciation of a spoken phrase against an expected text.',
            parameters: {
                type: 'object',
                properties: {
                    result: {
                        type: 'string',
                        enum: ['correct', 'incorrect', 'quit'],
                        description: 'The evaluation result'
                    },
                    message: {
                        type: 'string',
                        description: 'Feedback message explaining the evaluation'
                    }
                },
                required: ['result', 'message']
            }
        },
        getNextCard: {
            type: 'function',
            name: 'getNextCard',
            description: 'Get the next card in the deck.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        completeReview: {
            type: 'function',
            name: 'completeReview',
            description: 'Called when the review session is complete.',
            parameters: {
                type: 'object',
                properties: {
                    message: {
                        type: 'string',
                        description: 'Final message to show to the user'
                    }
                },
                required: ['message']
            }
        }
    };

    const realtimeTools = {
        sendMessage: (message) => {
            if (!dataChannelRef.current) return;
            dataChannelRef.current.send(JSON.stringify(message));
        },

        sendFunctionOutput: (callId, output) => {
            realtimeTools.sendMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify(output)
                }
            });
        },

        sendNextCardInfo: (nextCard, isLastCard, callId, result = 'correct', message = '') => {
            realtimeTools.sendFunctionOutput(callId, {
                result,
                message,
                nextCard: nextCard ? {
                    frontText: nextCard.frontText,
                    backText: nextCard.backText
                } : null,
                hasMoreCards: !isLastCard
            });
        },

        sendCompleteReview: () => {
            realtimeTools.sendMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call',
                    name: 'completeReview',
                    arguments: JSON.stringify({
                        message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                    })
                }
            });
        },

        requestNextResponse: () => {
            if (!hasActiveResponse) {
                console.log('Requesting next response');
                realtimeTools.sendMessage({
                    type: 'response.create'
                });
            }
        },

        configureSession: (card) => {
            if (!dataChannelRef.current) return;
    
            realtimeTools.sendMessage({
                type: 'session.update',
                session: {
                    instructions: `You are a friendly language learning tutor. First, give a brief welcome and explain that you'll help practice pronunciation.
            For each card: clearly say the front text (${card.frontText}) and wait for the user to respond with the TRANSLATION (${card.backText}).
            
            After EVERY user response (except "again"), you must:
            1. Evaluate their response using the evaluatePronunciation function:
               - result="correct" if they correctly translate AND pronounce "${card.backText}"
               - result="incorrect" if they say anything else (wrong translation, wrong pronunciation, or if they repeat "${card.frontText}")
               - result="quit" if they say "skip", "idk", or "next"
            2. After the function returns, give brief feedback based on the result
            
            Special cases:
            - If they say "again", just repeat "${card.frontText}" clearly
            - For incorrect responses, encourage them to try again
            - For correct responses, give quick praise before moving on
            
            Keep your responses friendly but concise. Focus on helping them learn.
            
            When there are no more cards, give a brief goodbye and encouragement.
            Current card - Front: "${card.frontText}", Back (expected translation): "${card.backText}"`,
                    tools: Object.values(sessionTools),
                    tool_choice: 'auto'
                }
            });
    
            // Start with a welcome message and introduce the first card
            realtimeTools.sendMessage({
                type: 'response.create',
                response: {
                    instructions: `Give a brief, friendly welcome and explain that you'll help them practice pronunciation and translation. Explain that you'll say a phrase, and they should respond with the correct translation. After the welcome, say "Let's start with our first card" and then clearly say: "${card.frontText}" and wait for the user to respond with the translation.`
                }
            });
        }
    };

    const handleAudioStarted = () => {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
        }
    };

    const handleAudioStopped = () => {
        console.log('input_audio_buffer.speech_stopped - unmuting microphone');
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
        }
        // If we're in a completed state and the AI just finished speaking, clean up
        if (!hasActiveResponse && review.currentCardIndex >= review.dueCards.length - 1) {
            console.log('AI finished farewell message, cleaning up connection');
            setTimeout(() => {
                if (mediaStreamRef.current) {
                    mediaStreamRef.current.getTracks().forEach(track => track.stop());
                }
                if (peerConnectionRef.current) {
                    peerConnectionRef.current.close();
                }
                setIsConnected(false);
                setHasStarted(false);
            }, 500);
        }
    };

    const handleTextDelta = (event) => {
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

    const handleCorrectResponse = (args, callId) => {
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

    const handleIncorrectResponse = (args, callId) => {
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
            handleMaxAttempts(callId);
        } else {
            realtimeTools.sendFunctionOutput(callId, {
                result: args.result,
                message: args.message
            });
        }
        realtimeTools.requestNextResponse();
    };

    const handleMaxAttempts = (callId) => {
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

    const handleSkipResponse = (args, callId) => {
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

    const handleAgainResponse = (args, callId) => {
        realtimeTools.sendFunctionOutput(callId, {
            result: args.result,
            message: args.message
        });
        realtimeTools.requestNextResponse();
    };

    const handleGetNextCard = (callId) => {
        const nextCardIndex = review.currentCardIndex + 1;
        const nextCard = review.dueCards[nextCardIndex];

        realtimeTools.sendFunctionOutput(callId, nextCard ? {
            frontText: nextCard.frontText,
            backText: nextCard.backText,
            hasMore: nextCardIndex < review.dueCards.length - 1
        } : null);
        realtimeTools.requestNextResponse();
    };

    const handleCompleteReviewFunction = (args, callId) => {
        setFeedback(args.message);
        realtimeTools.sendFunctionOutput(callId, { success: true });
        realtimeTools.requestNextResponse();
    };

    const handleFunctionCall = (item) => {
        console.log('Received function call:', { name: item.name, arguments: JSON.parse(item.arguments) }, '- Processing user response and updating UI accordingly');
        const args = JSON.parse(item.arguments);

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            switch (args.result) {
                case 'correct':
                    handleCorrectResponse(args, item.call_id);
                    break;
                case 'incorrect':
                    handleIncorrectResponse(args, item.call_id);
                    break;
                case 'quit':
                case 'skip':
                    handleSkipResponse(args, item.call_id);
                    break;
                case 'again':
                    handleAgainResponse(args, item.call_id);
                    break;
            }
        } else if (item.name === 'completeReview') {
            handleCompleteReviewFunction(args, item.call_id);
        } else if (item.name === 'getNextCard') {
            handleGetNextCard(item.call_id);
        }
    };

    const handleRealtimeEvent = (event) => {
        console.log('Realtime event:', event);
        switch (event.type) {
            case 'output_audio_buffer.audio_started':
                handleAudioStarted();
                break;
            case 'output_audio_buffer.audio_stopped':
                handleAudioStopped();
                break;
            case 'response.text.delta':
                handleTextDelta(event);
                break;
            case 'response.output_item.done':
                if (event.item.type === 'function_call') {
                    handleFunctionCall(event.item);
                }
                break;
            case 'response.complete':
                setHasActiveResponse(false);
                setIsSpeaking(false);
                break;
            case 'error':
                console.error('realtime api error:', event.error);
                setFeedback('error: ' + event.error.message);
                if (event.error.message === 'conversation already has an active response') {
                    setHasActiveResponse(true);
                }
                break;
            default:
                break;
        }
    };

    return {
        handleRealtimeEvent,
        showSkip,
        configureSession: realtimeTools.configureSession
    };
};