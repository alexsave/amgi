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

const EvaluationResponseSchema = z.object({
    result: z.enum(['correct', 'incorrect', 'quit']),
    message: z.string(),
    isCommand: z.boolean()
});

async function generateCards(userInput, targetLang) {
    console.log('Starting generateCards with input:', { userInput, targetLang });
    try {
        console.log('Requesting translation from OpenAI...');
        const completion = await openai.beta.chat.completions.parse({
            model: "gpt-4o",
            messages: [
                { 
                    role: "system", 
                    content: "You are a helpful language learning assistant that creates flashcard pairs with accurate translations. First detect the source language of the input text. If the detected source language matches the requested target language, translate to English. Otherwise, translate to the requested target language." 
                },
                { 
                    role: "user", 
                    content: `Create a language learning flashcard pair for the following input. 
First detect the language. If the detected language matches ${targetLang}, translate to English (en). Otherwise, translate to ${targetLang}.
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

async function evaluateSpeech(audioBase64, expectedText, sourceLang, expectedAudioBase64) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: `You are a language learning assistant evaluating pronunciation. First, check if the audio contains commands like "skip", "quit", "next", or "give up". If it does, respond with exactly "user skip".

If no command is detected, compare the pronunciation with the expected text "${expectedText}" in ${sourceLang}. If the pronunciation is good, respond with exactly "correct" followed by a brief praise. If the pronunciation needs improvement, respond with exactly "incorrect" followed by a brief explanation of what was wrong.

Remember to start your response with either "correct", "incorrect", or "user skip".`
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Here is the correct pronunciation:" },
                        { type: "input_audio", input_audio: { data: expectedAudioBase64, format: "mp3" }}
                    ]
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Evaluate this pronunciation:" },
                        { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" }}
                    ]
                }
            ]
        });

        console.log('GPT-4 Audio raw response:', response);
        const result = response.choices[0].message.audio?.transcript || '';
        console.log('GPT-4 Audio transcript:', result);

        // Parse the response
        let evaluationResult;
        if (result.toLowerCase().startsWith('correct')) {
            evaluationResult = {
                result: 'correct',
                message: result.substring(7).trim(), // Remove "correct" and trim
                isCommand: false
            };
        } else if (result.toLowerCase().startsWith('incorrect')) {
            evaluationResult = {
                result: 'incorrect',
                message: result.substring(9).trim(), // Remove "incorrect" and trim
                isCommand: false
            };
        } else if (result.toLowerCase().includes('user skip') || 
                  result.toLowerCase().includes('skip') || 
                  result.toLowerCase().includes('quit') || 
                  result.toLowerCase().includes('next')) {
            evaluationResult = {
                result: 'quit',
                message: 'User requested to skip',
                isCommand: true
            };
        } else {
            // Default case if response doesn't match expected format
            console.warn('Unexpected response format:', result);
            evaluationResult = {
                result: 'incorrect',
                message: 'Could not evaluate pronunciation clearly. Please try again.',
                isCommand: false
            };
        }

        return new Response(JSON.stringify(evaluationResult), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (error) {
        console.error('Error evaluating speech:', error);
        throw new Error('Failed to evaluate speech: ' + error.message);
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
        } catch (error) {
            console.error('Error handling request:', error);
            return new Response(
                JSON.stringify({ error: error.message }), 
                { status: 500, headers }
            );
        }
    }

    if (req.method === "POST" && url.pathname === "/api/evaluate_speech") {
        try {
            const body = await req.json();
            const { audioBase64, expectedText, sourceLang, expectedAudioBase64, audioFormat } = body;
            
            console.log('Received evaluate_speech request with parameters:', {
                hasAudioBase64: !!audioBase64,
                hasExpectedText: !!expectedText,
                hasSourceLang: !!sourceLang,
                hasExpectedAudioBase64: !!expectedAudioBase64,
                audioFormat,
                sourceLang,
                expectedTextLength: expectedText?.length,
                audioBase64Length: audioBase64?.length,
                expectedAudioBase64Length: expectedAudioBase64?.length
            });

            const missingParams = [];
            if (!audioBase64) missingParams.push('audioBase64');
            if (!expectedText) missingParams.push('expectedText');
            if (!sourceLang) missingParams.push('sourceLang');
            if (!expectedAudioBase64) missingParams.push('expectedAudioBase64');
            if (!audioFormat) missingParams.push('audioFormat');

            if (missingParams.length > 0) {
                console.error('Missing required parameters:', missingParams);
                return new Response(
                    JSON.stringify({ 
                        error: `Missing required parameters: ${missingParams.join(', ')}`,
                        receivedParams: Object.keys(body)
                    }), 
                    { status: 400, headers }
                );
            }

            // Convert audio format if needed
            let processedAudioBase64 = audioBase64;
            if (audioFormat === 'webm') {
                // For now, we'll just pass the webm data and let OpenAI handle it
                // In a production environment, we should convert webm to mp3 here
                console.log('Received webm audio, passing through to OpenAI');
            }

            return await evaluateSpeech(processedAudioBase64, expectedText, sourceLang, expectedAudioBase64);
        } catch (error) {
            console.error('Error handling speech evaluation:', error);
            return new Response(
                JSON.stringify({ error: error.message }), 
                { status: 500, headers }
            );
        }
    }

    return new Response("Not Found", { status: 404, headers });
}

Deno.serve({ port: 8000 }, handler);