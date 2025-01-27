import { useState } from 'react';

export const useRealtimeAPI = (mediaStreamRef, hasActiveResponse, review, peerConnectionRef, setIsConnected, setHasStarted, setIsSpeaking, setHasActiveResponse, setFeedback, isRecording, setIsRecording, animationFrameRef, setAudioScale, setButtonState, currentCard, dataChannelRef) => {

  const [showSkip, setShowSkip] = useState(false);

    const handleRealtimeEvent = (event) => {
        console.log('Realtime event:', event);
        switch (event.type) {
            case 'output_audio_buffer.audio_started':
                if (mediaStreamRef.current) {
                    mediaStreamRef.current.getAudioTracks().forEach(track => {
                        track.enabled = false;
                    });
                }
                break;

            case 'output_audio_buffer.audio_stopped':
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
                break;

            case 'response.text.delta':
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
                break;
            case 'response.output_item.done':
                const { item } = event;
                if (item.type === 'function_call') {
                    console.log('Received function call:', { name: item.name, arguments: JSON.parse(item.arguments) }, '- Processing user response and updating UI accordingly');
                    if (item.name === 'evaluatePronunciation') {
                        const args = JSON.parse(item.arguments);
                        setFeedback(args.message);

                        // Handle visual feedback based on result
                        if (args.result === 'correct') {
                            setButtonState('success');
                            setTimeout(() => setButtonState('default'), 500);
                            // Update card scheduling for correct answer
                            review.updateCardScheduling(currentCard.created, 'correct');

                            // Calculate next index and check if it would be the last card
                            const nextIndex = review.currentCardIndex + 1;
                            const isLastCard = nextIndex >= review.dueCards.length;

                            // Get next card info
                            const nextCard = isLastCard ? null : review.dueCards[nextIndex];

                            // Only move to next card if there is one
                            if (!isLastCard) {
                                review.moveToNextCard();
                            }

                            // Send the function result back with next card info
                            console.log('Evaluating next card status:', {
                                currentIndex: review.currentCardIndex,
                                nextIndex,
                                totalCards: review.dueCards.length,
                                isLastCard,
                                hasNextCard: !!nextCard,
                                explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
                            });
                            dataChannelRef.current?.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: item.call_id,
                                    output: JSON.stringify({
                                        result: args.result,
                                        message: args.message,
                                        nextCard: nextCard ? {
                                            frontText: nextCard.frontText,
                                            backText: nextCard.backText
                                        } : null,
                                        hasMoreCards: !isLastCard
                                    })
                                }
                            }));

                            // If this was the last card, call completeReview
                            if (isLastCard) {
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'function_call',
                                        name: 'completeReview',
                                        arguments: JSON.stringify({
                                            message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                                        })
                                    }
                                }));
                            }

                            // Request next response if no active response
                            if (!hasActiveResponse) {
                                console.log('Requesting next response after correct answer');
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'response.create'
                                }));
                            }

                        } else if (args.result === 'incorrect') {
                            setButtonState('error');
                            setTimeout(() => setButtonState('default'), 500);
                            review.updateCardScheduling(currentCard.created, 'incorrect');

                            // Update attempts and handle max attempts case
                            let shouldMoveToNext = false;
                            let nextCard = null;

                            review.setAttempts(prev => {
                                const newAttempts = prev + 1;
                                if (newAttempts >= 3) {
                                    shouldMoveToNext = true;
                                }
                                return newAttempts;
                            });

                            // Handle max attempts case outside setState
                            if (shouldMoveToNext) {
                                review.setShowAnswer(true);

                                // Calculate next index and check if it would be the last card
                                const nextIndex = review.currentCardIndex + 1;
                                const isLastCard = nextIndex >= review.dueCards.length;

                                // Get next card info
                                const nextCard = isLastCard ? null : review.dueCards[nextIndex];

                                // Only move to next card if there is one
                                if (!isLastCard) {
                                    review.moveToNextCard();
                                }

                                // Send function result with next card info after max attempts
                                console.log('Evaluating next card status (max attempts):', {
                                    currentIndex: review.currentCardIndex,
                                    nextIndex,
                                    totalCards: review.dueCards.length,
                                    isLastCard,
                                    hasNextCard: !!nextCard,
                                    explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
                                });
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'function_call_output',
                                        call_id: item.call_id,
                                        output: JSON.stringify({
                                            result: 'skip',
                                            message: 'Moving to next card after maximum attempts',
                                            nextCard: nextCard ? {
                                                frontText: nextCard.frontText,
                                                backText: nextCard.backText
                                            } : null,
                                            hasMoreCards: !isLastCard
                                        })
                                    }
                                }));

                                // If this was the last card, call completeReview
                                if (isLastCard) {
                                    dataChannelRef.current?.send(JSON.stringify({
                                        type: 'conversation.item.create',
                                        item: {
                                            type: 'function_call',
                                            name: 'completeReview',
                                            arguments: JSON.stringify({
                                                message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                                            })
                                        }
                                    }));
                                }
                            } else {
                                // Just acknowledge the incorrect attempt
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'function_call_output',
                                        call_id: item.call_id,
                                        output: JSON.stringify({
                                            result: args.result,
                                            message: args.message
                                        })
                                    }
                                }));
                            }

                            // Request next response if no active response
                            if (!hasActiveResponse) {
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'response.create'
                                }));
                            }

                        } else if (args.result === 'quit' || args.result === 'skip') {
                            setShowSkip(true);
                            setTimeout(() => setShowSkip(false), 500);
                            // Mark as incorrect and move to next card
                            review.updateCardScheduling(currentCard.created, 'incorrect');
                            review.setShowAnswer(true);

                            // Calculate next index and check if it would be the last card
                            const nextIndex = review.currentCardIndex + 1;
                            const isLastCard = nextIndex >= review.dueCards.length;

                            // Get next card info
                            const nextCard = isLastCard ? null : review.dueCards[nextIndex];

                            // Only move to next card if there is one
                            if (!isLastCard) {
                                review.moveToNextCard();
                            }

                            // Send function result with next card info
                            console.log('Evaluating next card status (skip/quit):', {
                                currentIndex: review.currentCardIndex,
                                nextIndex,
                                totalCards: review.dueCards.length,
                                isLastCard,
                                hasNextCard: !!nextCard,
                                explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
                            });
                            dataChannelRef.current?.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: item.call_id,
                                    output: JSON.stringify({
                                        result: args.result,
                                        message: args.message,
                                        nextCard: nextCard ? {
                                            frontText: nextCard.frontText,
                                            backText: nextCard.backText
                                        } : null,
                                        hasMoreCards: !isLastCard
                                    })
                                }
                            }));

                            // If this was the last card, call completeReview
                            if (isLastCard) {
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'conversation.item.create',
                                    item: {
                                        type: 'function_call',
                                        name: 'completeReview',
                                        arguments: JSON.stringify({
                                            message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                                        })
                                    }
                                }));
                            }

                            // Request next response if no active response
                            if (!hasActiveResponse) {
                                console.log('Requesting next response after skip');
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'response.create'
                                }));
                            }
                        } else if (args.result === 'again') {
                            // Just acknowledge the request to repeat
                            console.log('Sending function_call_output for evaluatePronunciation:', { result: args.result }, '- Repeating current card');
                            dataChannelRef.current?.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: item.call_id,
                                    output: JSON.stringify({
                                        result: args.result,
                                        message: args.message
                                    })
                                }
                            }));

                            // Request next response if no active response
                            if (!hasActiveResponse) {
                                console.log('Requesting next response after again');
                                dataChannelRef.current?.send(JSON.stringify({
                                    type: 'response.create'
                                }));
                            }
                        }
                    } else if (item.name === 'completeReview') {
                        const args = JSON.parse(item.arguments);
                        setFeedback(args.message);

                        // Send function result back first
                        console.log('Sending function_call_output for completeReview - Finishing review session');
                        dataChannelRef.current?.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: JSON.stringify({ success: true })
                            }
                        }));

                        // Request final response if no active response
                        if (!hasActiveResponse) {
                            console.log('Requesting final response after review completion');
                            dataChannelRef.current?.send(JSON.stringify({
                                type: 'response.create'
                            }));
                        }

                        // Don't close connection yet - we'll do it after the AI finishes speaking
                    } else if (item.name === 'getNextCard') {
                        // Get the next card info from review hook
                        const nextCardIndex = review.currentCardIndex + 1;
                        const nextCard = review.dueCards[nextCardIndex];

                        console.log('Evaluating next card status (getNextCard):', {
                            currentIndex: review.currentCardIndex,
                            nextIndex: nextCardIndex,
                            totalCards: review.dueCards.length,
                            hasNextCard: !!nextCard,
                            hasMore: nextCardIndex < review.dueCards.length - 1,
                            explanation: `Current index is ${review.currentCardIndex}, next index would be ${nextCardIndex}, total cards is ${review.dueCards.length}. hasMore=${nextCardIndex < review.dueCards.length - 1} because ${nextCardIndex} ${nextCardIndex < review.dueCards.length - 1 ? '<' : '>='} ${review.dueCards.length - 1}`
                        });
                        dataChannelRef.current?.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: JSON.stringify(nextCard ? {
                                    frontText: nextCard.frontText,
                                    backText: nextCard.backText,
                                    hasMore: nextCardIndex < review.dueCards.length - 1
                                } : null)
                            }
                        }));

                        // only request next response if there isn't an active one
                        if (!hasActiveResponse) {
                            console.log('sending response.create - no active response after getnextcard');
                            dataChannelRef.current?.send(JSON.stringify({
                                type: 'response.create'
                            }));
                        }
                    }
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
                //console.log('received event:', event);
                break;
        }
    }

    return {
        handleRealtimeEvent,
        showSkip
    }
}