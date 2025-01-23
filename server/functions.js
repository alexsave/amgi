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
});

const evaluationTools = [{
    "type": "function",
    "function": {
        "name": "evaluate_pronunciation",
        "description": "Evaluate the pronunciation of a spoken phrase against an expected text.",
        "parameters": {
            "type": "object",
            "properties": {
                "result": {
                    "type": "string",
                    "enum": ["correct", "incorrect", "quit"],
                    "description": "The evaluation result"
                },
                "message": {
                    "type": "string",
                    "description": "Feedback message explaining the evaluation"
                }
            },
            "required": ["result", "message"]
        }
    }
}];

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
                    content: `You are a language learning assistant evaluating pronunciation. First, check if the audio contains commands like "skip", "quit", "next", or "give up". If it does, call evaluate_pronunciation with result "quit" and message "User requested to skip".

If no command is detected, compare the pronunciation with the expected text "${expectedText}" in ${sourceLang}. If the pronunciation is good, call evaluate_pronunciation with result "correct" and a brief praise message. If the pronunciation needs improvement, call evaluate_pronunciation with result "incorrect" and a brief explanation of what was wrong.`
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
            ],
            tools: evaluationTools,
            tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
        });

        console.log('GPT-4 Audio raw response:', response);
        console.log('GPT-4 Audio response message:', response.choices[0].message);
        console.log('GPT-4 Audio data present:', !!response.choices[0].message.audio);
        if (response.choices[0].message.audio) {
            console.log('GPT-4 Audio data type:', typeof response.choices[0].message.audio);
            console.log('GPT-4 Audio data keys:', Object.keys(response.choices[0].message.audio));
            console.log('GPT-4 Audio data length:', response.choices[0].message.audio?.data?.length);
        }
        
        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            throw new Error('No tool call in response');
        }

        const evaluation = JSON.parse(toolCall.function.arguments);
        console.log('Parsed evaluation:', evaluation);

        const evaluationResult = {
            result: evaluation.result,
            message: evaluation.message,
            audio: response.choices[0].message.audio?.data
        };
        
        console.log('Sending evaluation result with audio:', !!evaluationResult.audio);
        if (evaluationResult.audio) {
            console.log('Audio data length in result:', evaluationResult.audio.length);
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

async function voiceChat(audioBase64, currentCard) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: `You are a helpful language learning tutor. The user is practicing with flashcards. 
                    The current card's front text is "${currentCard.frontText}" and back text is "${currentCard.backText}".
                    Help the user practice pronunciation, answer questions about the word/phrase, or provide examples.
                    Keep responses brief and focused. If you hear "quit" or "exit", inform them they can toggle voice mode off.`
                },
                {
                    role: "user",
                    content: [
                        { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" }}
                    ]
                }
            ]
        });

        const audioResponse = response.choices[0].message.audio?.data;
        const textResponse = response.choices[0].message.content;

        return new Response(JSON.stringify({
            text: textResponse,
            audio: audioResponse
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (error) {
        console.error('Error in voice chat:', error);
        throw new Error('Failed to process voice chat: ' + error.message);
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

    if (req.method === "POST" && url.pathname === "/api/voice_chat") {
        try {
            const body = await req.json();
            const { audioBase64, currentCard } = body;

            if (!audioBase64 || !currentCard) {
                return new Response(
                    JSON.stringify({ error: "audioBase64 and currentCard are required" }), 
                    { status: 400, headers }
                );
            }

            return await voiceChat(audioBase64, currentCard);
        } catch (error) {
            console.error('Error in voice chat endpoint:', error);
            return new Response(
                JSON.stringify({ error: error.message }), 
                { status: 500, headers }
            );
        }
    }

    return new Response("Not Found", { status: 404, headers });
}

Deno.serve({ port: 8000 }, handler);