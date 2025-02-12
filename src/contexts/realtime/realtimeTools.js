export const createRealtimeTools = (dataChannelRef) => ({
    sendFunctionOutput: (callId, output) => {
        if (!dataChannelRef.current) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(output)
            }
        }));
    },

    // This replies to a nextcard info
    sendNextCardInfo: (nextCard, isLastCard, callId, result = 'correct', message = '') => {
        if (!dataChannelRef.current) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({
                    result,
                    message,
                    nextCard: nextCard ? {
                        frontText: nextCard.frontText,
                        backText: nextCard.backText
                    } : null,
                    hasMoreCards: !isLastCard
                })
            }
        }));
    },

    // This replies to a correct card
    sendCompleteReview: (callId) => {
        if (!dataChannelRef.current) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({
                    message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                })
            }
        }));
    },

    // This is fine
    requestNextResponse: (hasActiveResponse) => {
        if (!dataChannelRef.current || hasActiveResponse) return;
        console.log('Requesting next response');
        dataChannelRef.current.send(JSON.stringify({
            type: 'response.create'
        }));
    }
}); 