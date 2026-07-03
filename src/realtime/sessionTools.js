import { getLanguageName } from '../constants/languages';
import { INITIAL_PROMPTS } from './initialPrompts';

export const sessionTools = {
    evaluatePronunciation: {
        type: 'function',
        name: 'evaluatePronunciation',
        description: 'Reports the quality of a pronunciation of a spoken phrase against an expected text. The function handler will return the next card to use, or null if the review is complete.',
        parameters: {
            type: 'object',
            properties: {
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

/**
 * Configures the realtime session over the data channel (GA API shape) and
 * kicks off the first response.
 */
export const configureSession = (dataChannel, card, learning_language, known_language = 'en') => {
    if (!dataChannel || !card) {
        return;
    }

    // Instructions localized to the learning language, with English fallback.
    const instructionTemplate = INITIAL_PROMPTS[learning_language] || INITIAL_PROMPTS.en;

    const instructions = instructionTemplate
        .replace(/{frontText}/g, card.front_text)
        .replace(/{backText}/g, card.back_text)
        .replace(/{known_language}/g, getLanguageName(known_language, known_language))
        .replace(/{learning_language}/g, getLanguageName(learning_language, known_language));

    const message = {
        type: 'session.update',
        session: {
            type: 'realtime',
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
