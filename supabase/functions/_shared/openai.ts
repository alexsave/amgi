import { OpenAI } from "openai";

export function createOpenAIClient() {
    const apiKey = Deno.env.get('OPENAI_KEY');
    if (!apiKey) {
        throw new Error('OpenAI API key not found');
    }
    
    return new OpenAI({
        apiKey: apiKey
    });
}