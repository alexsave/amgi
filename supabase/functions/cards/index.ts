/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import OpenAI from "https://deno.land/x/openai@v4.55.5/mod.ts";
import { zodResponseFormat } from "https://deno.land/x/openai@v4.55.5/helpers/zod.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FlashcardSchema = z.object({
    frontText: z.string(),
    backText: z.string(),
    sourceLang: z.string(),
    targetLang: z.string()
});

const encoder = new TextEncoder();

serve(async (req) => {
    console.log('Request received:', {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries())
    });

    if (req.method === 'OPTIONS') {
        console.log('Handling OPTIONS request');
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        console.log('Initializing OpenAI client...');
        const openai = new OpenAI({
            apiKey: Deno.env.get('OPENAI_KEY'),
        });

        const requestBody = await req.json();
        const { userInput, targetLang } = requestBody;
        console.log('Request payload:', { userInput, targetLang });

        console.log('Requesting translation from OpenAI with params:', {
            model: "gpt-4o",
            targetLang,
            inputLength: userInput.length
        });
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

        const rawCard = JSON.parse(completion.choices[0]?.message?.content || '{}');
        console.log('Raw OpenAI response:', completion.choices[0]?.message?.content);
        
        const parseResult = FlashcardSchema.safeParse(rawCard);
        if (!parseResult.success) {
            console.error('Schema validation failed:', parseResult.error);
            throw new Error('Failed to parse card data from OpenAI response');
        }
        const card = parseResult.data;
        console.log('Parsed card data:', card);

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    console.log('Starting stream processing...');
                    // Send card data first
                    const cardData = JSON.stringify({
                        type: 'card',
                        data: card
                    }) + '\n';
                    console.log('Sending card data chunk:', cardData);
                    controller.enqueue(encoder.encode(cardData));

                    // Generate and send front audio
                    console.log('Generating front audio with params:', {
                        model: "tts-1",
                        voice: "alloy",
                        textLength: card.frontText.length
                    });
                    const frontMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.frontText,
                    });
                    const frontBuffer = await frontMp3.arrayBuffer();
                    console.log('Front audio buffer size:', frontBuffer.byteLength);
                    
                    const frontAudioData = JSON.stringify({
                        type: 'audio',
                        side: 'front',
                        data: Array.from(new Uint8Array(frontBuffer))
                    }) + '\n';
                    console.log('Sending front audio chunk of size:', frontAudioData.length);
                    controller.enqueue(encoder.encode(frontAudioData));

                    // Generate and send back audio
                    console.log('Generating back audio with params:', {
                        model: "tts-1",
                        voice: "alloy",
                        textLength: card.backText.length
                    });
                    const backMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.backText,
                    });
                    const backBuffer = await backMp3.arrayBuffer();
                    console.log('Back audio buffer size:', backBuffer.byteLength);
                    
                    const backAudioData = JSON.stringify({
                        type: 'audio',
                        side: 'back',
                        data: Array.from(new Uint8Array(backBuffer))
                    }) + '\n';
                    console.log('Sending back audio chunk of size:', backAudioData.length);
                    controller.enqueue(encoder.encode(backAudioData));

                    controller.close();
                    console.log('Stream successfully closed');
                } catch (error) {
                    console.error('Stream error details:', {
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                        cause: error.cause
                    });
                    controller.error(error);
                }
            }
        });

        console.log('Returning stream response');
        return new Response(stream, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error) {
        console.error('Function error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause
        });
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
}); 