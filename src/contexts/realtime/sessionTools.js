export const sessionTools = {
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

export const configureSession = (dataChannel, card, tools) => {
    console.log('Configuring session...');
    if (!dataChannel) {
        console.error('No data channel available');
        return;
    }
    if (!card) {
        console.error('No card provided');
        return;
    }

    console.log('Preparing session update message...');
    const message = {
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
            tools: Object.values(tools),
            tool_choice: 'auto'
        }
    };

    console.log('Sending session update...');
    try {
        dataChannel.send(JSON.stringify(message));
        console.log('Session update sent successfully');

        console.log('Sending initial welcome message...');
        dataChannel.send(JSON.stringify({
            type: 'response.create',
            response: {
                instructions: `Give a brief, friendly welcome and explain that you'll help them practice pronunciation and translation. Explain that you'll say a phrase, and they should respond with the correct translation. After the welcome, say "Let's start with our first card" and then clearly say: "${card.frontText}" and wait for the user to respond with the translation.`
            }
        }));
        console.log('Welcome message sent successfully');
    } catch (error) {
        console.error('Error sending messages:', error);
        throw new Error('Failed to configure session: ' + error.message);
    }
}; 