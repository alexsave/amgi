/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "std/http/server"
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { getSubscription, getOrCreateUsage, updateUsage, checkUsageLimits } from "../_shared/billing.ts";
import { createOpenAIClient } from "../_shared/openai.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0"

const FlashcardSchema = z.object({
    front_text: z.string().describe("The front of the flashcard"),
    back_text: z.string().describe("The back of the flashcard"),
    frontLang: z.string().describe("The language of the front of the flashcard"),
    backLang: z.string().describe("The language of the back of the flashcard")
});

const encoder = new TextEncoder();

const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

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
        const { userInput, knownLanguage, learningLanguage } = requestBody;
        console.log('Request payload:', { userInput, knownLanguage, learningLanguage });

        // Generate card text first
        console.log('Requesting translation from OpenAI with params:', {
            model: "gpt-4",
            knownLanguage,
            learningLanguage,
            inputLength: userInput.length
        });
        const completion = await openai.beta.chat.completions.parse({
            model: "gpt-4o",
            messages: [
                { 
                    role: "system", 
                    content: "You are a language learning flashcard creator. Your task is to create flashcards where the FRONT is ALWAYS in the user's known language, and the BACK is ALWAYS in the learning language. You'll first detect the language of the input text and then create the appropriate flashcard based on this detection." 
                },
                { 
                    role: "user", 
                    content: `Create a flashcard for language learning following these rules:

1. First, detect the language of this input: "${userInput}"

2. Then create a flashcard where:
   - The FRONT is ALWAYS in ${knownLanguage}
   - The BACK is ALWAYS in ${learningLanguage}

3. Use these rules based on detection:
   - If input is in ${knownLanguage}: Front = original input, Back = translation to ${learningLanguage}
   - If input is in ${learningLanguage}: Front = translation to ${knownLanguage}, Back = original input
   - If input is in any other language: Front = translation to ${knownLanguage}, Back = translation to ${learningLanguage}

Return the flashcard with language codes.`
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

        // Upload front audio to storage
        const frontAudioPath = `${Date.now()}_front_${Math.random().toString(36).substr(2, 9)}.mp3`;
        const { data: frontData, error: frontError } = await supabaseClient.storage
            .from('card-audio')
            .upload(frontAudioPath, frontBuffer, {
                contentType: 'audio/mpeg',
                cacheControl: '3600'
            });
        
        if (frontError) {
            console.error('Error uploading front audio:', frontError);
            throw frontError;
        }

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

        // Upload back audio to storage
        const backAudioPath = `${Date.now()}_back_${Math.random().toString(36).substr(2, 9)}.mp3`;
        const { data: backData, error: backError } = await supabaseClient.storage
            .from('card-audio')
            .upload(backAudioPath, backBuffer, {
                contentType: 'audio/mpeg',
                cacheControl: '3600'
            });
        
        if (backError) {
            console.error('Error uploading back audio:', backError);
            throw backError;
        }

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
                    backLang: card.backLang,
                    frontAudioPath,
                    backAudioPath
                }
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