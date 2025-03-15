import { INITIAL_PROMPTS } from '../../constants/languages';

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
                message: {
                    type: 'string',
                    description: 'Feedback message explaining the evaluation'
                }
            },
            required: ['result', 'message']
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

// Map of localized instructions by language

export const configureSession = (dataChannel, card, learning_language) => {
    console.log('configureSession ' + JSON.stringify(card));
    if (!dataChannel || !card) {
        return;
    }
    
    // Get language-specific instructions or fall back to default
    const instructionTemplate = INITIAL_PROMPTS[learning_language || 'en'];

    // Build complete instructions with the proper evaluation criteria
    const instructions = instructionTemplate
        .replace(/{frontText}/g, card.front_text)
        .replace(/{backText}/g, card.back_text);

    const message = {
        type: 'session.update',
        session: {
            instructions: instructions,
            tools: Object.values(sessionTools),
            tool_choice: 'auto'
        }
    };

    try {
        dataChannel.send(JSON.stringify(message));

        dataChannel.send(JSON.stringify({
            type: 'response.create'
        }));
    } catch (error) {
        throw new Error('Failed to configure session: ' + error.message);
    }
}; 