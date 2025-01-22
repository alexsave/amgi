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

async function generateAudio(text, filename) {
    try {
        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: text,
        });

        const buffer = await mp3.arrayBuffer();
        const uint8Array = new Uint8Array(buffer);
        await Deno.writeFile(`./audio/${filename}`, uint8Array);
        return `/audio/${filename}`;
    } catch (error) {
        console.error('Error generating audio:', error);
        throw new Error('Failed to generate audio');
    }
}

async function generateCards(userInput, sourceLang = 'en') {
    try {
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
        
        // Generate unique filenames for audio files
        const frontAudioFilename = `${Date.now()}-front.mp3`;
        const backAudioFilename = `${Date.now()}-back.mp3`;

        // Generate audio for both front and back text
        const [frontAudioUrl, backAudioUrl] = await Promise.all([
            generateAudio(card.frontText, frontAudioFilename),
            generateAudio(card.backText, backAudioFilename)
        ]);

        // Add the generated audio URLs to the response
        return {
            ...card,
            frontAudioUrl,
            backAudioUrl
        };
    } catch (error) {
        console.error('Error generating cards:', error);
        throw new Error('Failed to generate flashcard content');
    }
}

// Ensure audio directory exists
try {
    await Deno.mkdir('./audio', { recursive: true });
} catch (error) {
    if (error?.code !== 'EEXIST') {
        console.error('Error creating audio directory:', error);
    }
}

// Serve static audio files
async function serveAudioFile(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/audio/')) {
        try {
            const audioPath = `.${url.pathname}`;
            const file = await Deno.readFile(audioPath);
            return new Response(file, {
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        } catch (error) {
            return new Response('Audio file not found', { status: 404 });
        }
    }
    return null;
}

async function handler(req) {
    const origin = req.headers.get("Origin") || "http://localhost:3000";
    const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/json",
    };

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { headers });
    }

    const url = new URL(req.url);
    
    if (req.method === "GET" && req.url.includes('/audio/')) {
        const audioResponse = await serveAudioFile(req);
        if (audioResponse) return audioResponse;
    }

    if (req.method === "POST" && url.pathname === "/api/generate_cards") {
        console.log("Generating cards");
        try {
            const body = await req.json();
            const { userInput, sourceLang } = body;

            if (!userInput) {
                return new Response(
                    JSON.stringify({ error: "userInput is required" }), 
                    { status: 400, headers }
                );
            }

            const cardData = await generateCards(userInput, sourceLang);
            return new Response(
                JSON.stringify(cardData),
                { headers }
            );
        } catch (error) {
            return new Response(
                JSON.stringify({ error: error.message }), 
                { status: 500, headers }
            );
        }
    }

    return new Response("Not Found", { status: 404, headers });
}

Deno.serve({ port: 8000 }, handler);