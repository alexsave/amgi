/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "std/http/server"
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { getSubscription, getOrCreateUsage, updateUsage, checkUsageLimits } from "../_shared/billing.ts";
import { createOpenAIClient } from "../_shared/openai.ts";

const FlashcardSchema = z.object({
    front_text: z.string(),
    back_text: z.string(),
    frontLang: z.string(),
    backLang: z.string()
});

const encoder = new TextEncoder();

serve(async (req) => {
    console.log('Request received:', {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries())
    });

    // Handle CORS
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    try {
        // Initialize OpenAI
        console.log('Initializing OpenAI client...');
        const openai = createOpenAIClient();

        // Authenticate user
        const user = await getAuthenticatedUser(req);

        // Get subscription and usage data
        const subscription = await getSubscription(user.id);
        const usage = await getOrCreateUsage(user.id, subscription);

        const requestBody = await req.json();
        const { userInput, targetLang } = requestBody;
        console.log('Request payload:', { userInput, targetLang });

        // Generate card text first
        console.log('Requesting translation from OpenAI with params:', {
            model: "gpt-4",
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

        // Generate front audio
        console.log('Generating front audio with params:', {
            model: "tts-1",
            voice: "alloy",
            textLength: card.front_text.length
        });
        const frontMp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: card.front_text,
        });
        const frontBuffer = await frontMp3.arrayBuffer();
        console.log('Front audio buffer size:', frontBuffer.byteLength);

        // Generate back audio
        console.log('Generating back audio with params:', {
            model: "tts-1",
            voice: "alloy",
            textLength: card.back_text.length
        });
        const backMp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: card.back_text,
        });
        const backBuffer = await backMp3.arrayBuffer();
        console.log('Back audio buffer size:', backBuffer.byteLength);

        // Check and update audio generation usage
        checkUsageLimits(usage, subscription, 'card_audio_generations_used');
        await updateUsage(usage.id, {
            card_audio_generations_used: usage.card_audio_generations_used + 2 // +2 for both front and back
        });

        // Return all data at once
        return new Response(
            JSON.stringify({
                card: {
                    front_text: card.front_text,
                    back_text: card.back_text,
                    frontLang: card.frontLang,
                    backLang: card.backLang
                },
                frontAudio: Array.from(new Uint8Array(frontBuffer)),
                backAudio: Array.from(new Uint8Array(backBuffer))
            }),
            {
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            }
        );

    } catch (error) {
        console.error('Error processing request:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    }
}); 