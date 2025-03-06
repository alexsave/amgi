export const sessionTools = {
    evaluatePronunciation: {
        type: 'function',
        name: 'evaluatePronunciation',
        description: 'Reports the quality of a pronunciations of a spoken phrase against an expected text. The function handler will return the next card to use, or null if the review is complete.',
        parameters: {
            type: 'object',
            properties: {
                // Consider a numeric rating instead of correct/incorrect
                result: {
                    type: 'string',
                    enum: ['correct', 'incorrect'],
                    description: 'The evaluation result'
                },
                pronunciation_quality: {
                    type: 'number',
                    description: 'A numeric rating of the pronunciation quality, from 0 to 100'
                },
                translation_quality: {
                    type: 'number',
                    description: 'A numeric rating of the translation quality, from 0 to 100'
                },
                message: {
                    type: 'string',
                    description: 'Feedback message explaining the evaluation'
                }
            },
            required: ['result', 'message', 'pronunciation_quality', 'translation_quality']
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

export const configureSession = (dataChannel, card) => {
    if (!dataChannel) {
        return;
    }
    if (!card) {
        return;
    }

    const message = {
        type: 'session.update',
        session: {
            instructions: `You are a friendly language learning tutor. First, give a brief welcome and briefly explain that you'll help practice pronunciation.
    For each card: clearly say the front text (${card.front_text}) and wait for the user to respond with the TRANSLATION (${card.back_text}).
    
    After EVERY user response you MUST evaluate their response using the evaluatePronunciation function, even if they say it wrong:
       - result="correct" if they correctly translate AND pronounce "${card.back_text}"
       - result="incorrect" if they say anything else (wrong translation, wrong pronunciation, or if they repeat "${card.front_text}")

    The function handler will return the next card to use, or null if the review is complete.
    If the function returns null, you should end the session with a brief goodbye and encouragement, then call the completeReview function.
    
    Keep your responses friendly but concise. Focus on helping them learn.
    
    When there are no more cards, give a brief goodbye and encouragement.
    Current card - Front: "${card.front_text}", Back (expected translation): "${card.back_text}"`,
            tools: Object.values(sessionTools),
            tool_choice: 'auto'
        }
    };

    try {
        dataChannel.send(JSON.stringify(message));

        dataChannel.send(JSON.stringify({
            type: 'response.create',
            response: {
                instructions: `Give a brief, friendly welcome and explain that you'll help them practice pronunciation and translation. Explain that you'll say a phrase, and they should respond with the correct translation. After the welcome, say "Let's start with our first card" and then clearly say: "${card.front_text}" and wait for the user to respond with the translation.`
            }
        }));
    } catch (error) {
        throw new Error('Failed to configure session: ' + error.message);
    }
}; 