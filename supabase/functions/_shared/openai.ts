import { OpenAI } from "openai";

/**
 * Creates and returns an initialized OpenAI client.
 * 
 * @returns An initialized OpenAI client
 * @throws Error if the OpenAI API key is not set in environment variables
 */
export function createOpenAIClient() {
    const apiKey = Deno.env.get('OPENAI_KEY');
    if (!apiKey) {
        console.error('OpenAI API key not found in environment variables');
        throw new Error('OpenAI API key not found');
    }
    
    try {
        return new OpenAI({
            apiKey: apiKey
        });
    } catch (error) {
        console.error('Error initializing OpenAI client:', error);
        throw new Error(`Failed to initialize OpenAI client: ${error.message}`);
    }
}