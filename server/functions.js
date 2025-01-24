import OpenAI from "openai";
import "jsr:@std/dotenv/load";
import { generateCards } from "./cards/cards.js";
import { evaluateSpeech } from "./speech/speech.js";
import { voiceChat } from "./voice/voice.js";
import { generateEphemeralToken, setupRealtimeVoiceConnection } from "./realtime/realtime.js";

const ALLOWED_ORIGINS = ["http://localhost:3000"];

export const openai = new OpenAI({
    apiKey: Deno.env.get("OPEN_AI_KEY"),
});

// Combine both HTTP and WebSocket handling
Deno.serve({ port: 8000 }, async (req) => {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "http://localhost:3000";
    const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    };

    // Handle WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        console.log('Client connected to WebSocket');
        
        try {
            const openaiWs = await setupRealtimeVoiceConnection(socket);
            
            socket.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'audio') {
                        // Forward audio data to OpenAI
                        openaiWs.send(JSON.stringify({
                            type: 'input_audio_buffer.append',
                            buffer: data.buffer
                        }));
                    }
                } catch (error) {
                    console.error('Error handling message:', error);
                    socket.send(JSON.stringify({
                        type: 'error',
                        error: 'Failed to process message'
                    }));
                }
            };
            
            socket.onclose = () => {
                console.log('Client disconnected');
                openaiWs?.close();
            };
            
            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            
            return response;
        } catch (error) {
            console.error('Error in WebSocket setup:', error);
            return new Response('WebSocket setup failed', { status: 500 });
        }
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { headers });
    }

    // Handle HTTP requests
    try {
        if (req.method === "GET" && url.pathname === "/api/realtime-token") {
            try {
                const token = await generateEphemeralToken();
                return new Response(JSON.stringify(token), {
                    headers: {
                        ...headers,
                        'Content-Type': 'application/json'
                    }
                });
            } catch (error) {
                console.error('Error generating token:', error);
                return new Response(
                    JSON.stringify({ error: error.message }), 
                    { status: 500, headers }
                );
            }
        }

        if (req.method === "POST" && url.pathname === "/api/generate_cards") {
            const body = await req.json();
            console.log('Received request body:', body);
            const { userInput, targetLang } = body;

            if (!userInput) {
                return new Response(
                    JSON.stringify({ error: "userInput is required" }), 
                    { status: 400, headers }
                );
            }

            if (!targetLang) {
                return new Response(
                    JSON.stringify({ error: "targetLang is required" }), 
                    { status: 400, headers }
                );
            }

            return await generateCards(userInput, targetLang);
        }

        if (req.method === "POST" && url.pathname === "/api/evaluate_speech") {
            const body = await req.json();
            const { audioBase64, expectedText, sourceLang, expectedAudioBase64, audioFormat } = body;
            
            const missingParams = [];
            if (!audioBase64) missingParams.push('audioBase64');
            if (!expectedText) missingParams.push('expectedText');
            if (!sourceLang) missingParams.push('sourceLang');
            if (!expectedAudioBase64) missingParams.push('expectedAudioBase64');
            if (!audioFormat) missingParams.push('audioFormat');

            if (missingParams.length > 0) {
                return new Response(
                    JSON.stringify({ 
                        error: `Missing required parameters: ${missingParams.join(', ')}`,
                        receivedParams: Object.keys(body)
                    }), 
                    { status: 400, headers }
                );
            }

            return await evaluateSpeech(audioBase64, expectedText, sourceLang, expectedAudioBase64);
        }

        if (req.method === "POST" && url.pathname === "/api/voice_chat") {
            const body = await req.json();
            const { audioBase64, currentCard } = body;

            if (!audioBase64 || !currentCard) {
                return new Response(
                    JSON.stringify({ error: "audioBase64 and currentCard are required" }), 
                    { status: 400, headers }
                );
            }

            return await voiceChat(audioBase64, currentCard);
        }

        return new Response("Not Found", { status: 404, headers });
    } catch (error) {
        console.error('Error handling request:', error);
        return new Response(
            JSON.stringify({ error: error.message }), 
            { status: 500, headers }
        );
    }
}); 