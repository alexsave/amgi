import OpenAI from "openai";

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

export async function generateEphemeralToken() {
    try {
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${Deno.env.get("OPEN_AI_KEY")}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-realtime-preview-2024-12-17",
                voice: "shimmer",
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to generate token: ${response.statusText}`);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error generating ephemeral token:', error);
        throw error;
    }
}

export async function setupRealtimeVoiceConnection(ws) {
    try {
        const openaiWs = await connectToOpenAI();
        setupOpenAIHandlers(openaiWs, ws);
        return openaiWs;
    } catch (error) {
        console.error('Error setting up OpenAI connection:', error);
        ws.send(JSON.stringify({
            type: 'error',
            error: 'Failed to connect to OpenAI'
        }));
    }
}

async function connectToOpenAI() {
    const headers = {
        'Authorization': `Bearer ${Deno.env.get("OPEN_AI_KEY")}`,
        'OpenAI-Beta': 'realtime=v1'
    };

    return new WebSocket(OPENAI_REALTIME_URL, undefined, {
        headers
    });
}

function setupOpenAIHandlers(openaiWs, clientWs) {
    const instructions = `You are a helpful language learning tutor. Help the user practice pronunciation, 
    answer questions about words/phrases, and provide examples. Keep responses brief and focused.
    If you hear "quit" or "exit", inform them they can toggle voice mode off.`;

    openaiWs.onopen = () => {
        console.log('Connected to OpenAI WebSocket');
        // Basic settings for Realtime API
        openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                voice: 'shimmer',
                instructions: instructions,
                input_audio_transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad' }
            }
        }));

        // Set up function calling
        openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                tools: [{
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
                }],
                tool_choice: 'auto'
            }
        }));
    };

    openaiWs.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
            case 'response.audio.delta':
                // Forward audio to client
                clientWs.send(JSON.stringify({
                    type: 'audio',
                    data: message.delta
                }));
                break;
                
            case 'response.output_item.done':
                const { item } = message;
                if (item.type === 'function_call' && item.name === 'evaluatePronunciation') {
                    const args = JSON.parse(item.arguments);
                    // Send evaluation result to client
                    clientWs.send(JSON.stringify({
                        type: 'evaluation',
                        result: args.result,
                        message: args.message
                    }));
                    
                    // Request response generation
                    openaiWs.send(JSON.stringify({ type: 'response.create' }));
                }
                break;
                
            case 'error':
                console.error('OpenAI WebSocket Error:', message.error);
                clientWs.send(JSON.stringify({
                    type: 'error',
                    error: message.error
                }));
                break;
        }
    };

    openaiWs.onerror = (error) => {
        console.error('OpenAI WebSocket error:', error);
        clientWs.send(JSON.stringify({
            type: 'error',
            error: 'OpenAI connection error'
        }));
    };

    return openaiWs;
}
