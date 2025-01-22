// A bunch of shit we can call from the client, we will make OpenAI calls from here
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import "jsr:@std/dotenv/load";

const ALLOWED_ORIGINS = ["http://localhost:3000"];

const openai = new OpenAI({
    apiKey: Deno.env.get("OPEN_AI_KEY"),
});

const FlashcardSchema = z.object({
    frontText: z.string(),
    backText: z.string(),
    sourceLang: z.string(),
    targetLang: z.string()
});

const encoder = new TextEncoder();

async function generateCards(userInput, sourceLang = 'en') {
    console.log('Starting generateCards with input:', { userInput, sourceLang });
    try {
        console.log('Requesting translation from OpenAI...');
        const completion = await openai.beta.chat.completions.parse({
            model: "gpt-4o",
            messages: [
                { 
                    role: "system", 
                    content: "You are a helpful language learning assistant that creates flashcard pairs with accurate translations." 
                },
                { 
                    role: "user", 
                    content: `Create a language learning flashcard pair for the following input. 
If the source language is ${sourceLang}, translate to English. If it's English, translate to ${sourceLang}.
Input: ${userInput}

Return just the translation pair with language codes.`
                }
            ],
            response_format: zodResponseFormat(FlashcardSchema, "flashcard_generation"),
        });

        const card = completion.choices[0].message.parsed;
        console.log('Received translation:', card);

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Send card data first
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'card',
                        data: card
                    }) + '\n'));

                    // Generate and send front audio
                    console.log('Generating front audio...');
                    const frontMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.frontText,
                    });
                    const frontBuffer = await frontMp3.arrayBuffer();
                    console.log('Front audio generated');
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'front',
                        data: Array.from(new Uint8Array(frontBuffer))
                    }) + '\n'));
                    console.log('Front audio sent');

                    // Generate and send back audio
                    console.log('Generating back audio...');
                    const backMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.backText,
                    });
                    const backBuffer = await backMp3.arrayBuffer();
                    console.log('Back audio generated');
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'back',
                        data: Array.from(new Uint8Array(backBuffer))
                    }) + '\n'));
                    console.log('Back audio sent');

                    controller.close();
                    console.log('Stream closed');
                } catch (error) {
                    console.error('Error in stream:', error);
                    controller.error(error);
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        console.error('Error in generateCards:', error);
        throw new Error('Failed to generate flashcard content');
    }
}

async function handler(req) {
    console.log('Received request:', req.method, req.url);
    const origin = req.headers.get("Origin") || "http://localhost:3000";
    const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    };

    if (req.method === "OPTIONS") {
        return new Response(null, { headers });
    }

    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/api/generate_cards") {
        try {
            const body = await req.json();
            console.log('Received request body:', body);
            const { userInput, sourceLang } = body;

            if (!userInput) {
                return new Response(
                    JSON.stringify({ error: "userInput is required" }), 
                    { status: 400, headers }
                );
            }

            return await generateCards(userInput, sourceLang);
        } catch (error) {
            console.error('Error handling request:', error);
            return new Response(
                JSON.stringify({ error: error.message }), 
                { status: 500, headers }
            );
        }
    }

    return new Response("Not Found", { status: 404, headers });
}

Deno.serve({ port: 8000 }, handler);