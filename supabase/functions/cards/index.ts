/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import OpenAI from "npm:openai@4.24.0"
import { z } from "npm:zod@3.22.4"

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
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const openai = new OpenAI({
            apiKey: Deno.env.get('OPENAI_KEY'),
        });

        const { userInput, targetLang } = await req.json()

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
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
            response_format: { type: "json_object" }
        });

        const card = JSON.parse(completion.choices[0].message.content);

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Send card data first
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'card',
                        data: card
                    }) + '\n'));

                    // Generate and send front audio
                    const frontMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.frontText,
                    });
                    const frontBuffer = await frontMp3.arrayBuffer();
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'front',
                        data: Array.from(new Uint8Array(frontBuffer))
                    }) + '\n'));

                    // Generate and send back audio
                    const backMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.backText,
                    });
                    const backBuffer = await backMp3.arrayBuffer();
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'back',
                        data: Array.from(new Uint8Array(backBuffer))
                    }) + '\n'));

                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            }
        });

        return new Response(stream, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
}) 