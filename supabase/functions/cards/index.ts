/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "std/http/server"
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { createOpenAIClient } from "../_shared/openai.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0"

const FlashcardSchema = z.object({
    front_text: z.string().describe("The front of the flashcard"),
    back_text: z.string().describe("The back of the flashcard"),
    front_lang: z.string().describe("The language of the front of the flashcard"),
    back_lang: z.string().describe("The language of the back of the flashcard")
});

// Define evaluation tools for audio validation
const audioValidationTools = [{
    "type": "function",
    "function": {
        "name": "validate_audio",
        "description": "Validate if the audio contains valid speech matching the expected text",
        "parameters": {
            "type": "object",
            "properties": {
                "is_valid": {
                    "type": "boolean",
                    "description": "Whether the audio contains valid speech matching the expected text"
                },
                "transcription": {
                    "type": "string",
                    "description": "The transcribed text from the audio"
                }
            },
            "required": ["is_valid", "transcription"]
        }
    }
}];

const encoder = new TextEncoder();

const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

/**
 * Validates generated audio by transcribing it and checking if it matches expected text
 */
async function validateAndGenerateAudio(
    openai,
    text: string,
    language: string,
    maxAttempts = 3
): Promise<ArrayBuffer> {
    let audioBuffer: ArrayBuffer | null = null;
    let isValidAudio = false;
    let attempts = 0;

    while (!isValidAudio && attempts < maxAttempts) {
        attempts++;
        console.log(`Audio generation attempt ${attempts}/${maxAttempts} for text in ${language}`);

        try {
            // Generate audio
            const audioMp3 = await openai.audio.speech.create({
                model: "gpt-4o-mini-tts",
                voice: "alloy",
                input: text,
                // Consider array of instructions for each language
                instructions: `Speak like a native speaker of ${language}. Use proper pronunciation and intonation for language learning purposes.`
            });

            const tempBuffer = await audioMp3.arrayBuffer();
            console.log('Audio buffer size:', tempBuffer.byteLength);

            // Convert to base64 for validation
            const audioBase64 = btoa(String.fromCharCode(...new Uint8Array(tempBuffer)));

            // Validate with transcription using function calling
            console.log(`Validating audio for "${text}" in ${language}`);
            const response = await openai.chat.completions.create({
                model: "gpt-4o-audio-preview",
                modalities: ["text", "audio"],
                audio: { voice: "alloy", format: "mp3" },
                messages: [
                    {
                        role: "system",
                        content: "You are an audio validation assistant. Listen to the audio and determine if it contains valid speech that matches or is similar to the expected text."
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Validate if this audio contains valid speech that matches the expected text: "${text}" in language: ${language}`
                            },
                            {
                                type: "input_audio",
                                input_audio: { data: audioBase64, format: "mp3" }
                            }
                        ]
                    }
                ],
                tools: audioValidationTools,
                tool_choice: { type: "function", function: { name: "validate_audio" } }
            });

            const toolCall = response.choices[0].message.tool_calls?.[0];

            if (!toolCall) {
                console.error('No tool call in response');
                continue;
            }

            const validationResult = JSON.parse(toolCall.function.arguments);
            console.log('Audio validation result:', validationResult);

            // Check validity
            if (validationResult.is_valid && validationResult.transcription.trim().length > 0) {
                isValidAudio = true;
                audioBuffer = tempBuffer; // Only assign to audioBuffer if validation passes
                console.log('Audio validation successful - transcription:', validationResult.transcription);
            } else {
                console.log('Audio validation failed - transcription:', validationResult.transcription);
            }
        } catch (audioError) {
            console.error(`Audio generation attempt ${attempts} failed:`, audioError);
        }
    }

    if (!isValidAudio || !audioBuffer) {
        throw new Error(`Failed to generate valid audio for "${text}" after ${attempts} attempts`);
    }

    return audioBuffer;
}

/**
 * Handles the complete audio generation process for a card side
 * including validation, old file cleanup, and storage
 */
async function processCardAudio(
    openai,
    supabaseClient,
    text: string,
    language: string,
    oldAudioPath: string | undefined,
    side: 'front' | 'back'
): Promise<string> {

    try {
        // Generate and validate audio
        const audioBuffer = await validateAndGenerateAudio(
            openai,
            text,
            language
        );

        // Delete old audio if it exists
        if (oldAudioPath) {
            try {
                await supabaseClient.storage
                    .from('card-audio')
                    .remove([oldAudioPath]);
                console.log(`Deleted old ${side} audio:`, oldAudioPath);
            } catch (deleteError) {
                console.error(`Error deleting old ${side} audio:`, deleteError);
                // Continue execution even if deletion fails
            }
        }

        // Upload new audio to storage
        const audioPath = `${Date.now()}_${side}_${Math.random().toString(36).substr(2, 9)}.mp3`;
        const { data, error } = await supabaseClient.storage
            .from('card-audio')
            .upload(audioPath, audioBuffer, {
                contentType: 'audio/mpeg',
                cacheControl: '3600'
            });

        if (error) {
            console.error(`Error uploading ${side} audio:`, error);
            throw error;
        }

        return audioPath;
    } catch (audioError) {
        console.error(`${side} audio processing failed:`, audioError);
        throw audioError;
    }
}

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
        // Authenticate user
        const user = await getAuthenticatedUser(req);

        const requestBody = await req.json();
        const {
            user_input,
            known_language,
            learning_language,
            regenerate_parts = [],
            current_card = null
        } = requestBody;

        console.log('Request payload:', {
            user_input,
            known_language,
            learning_language,
            regenerate_parts,
            has_current_card: !!current_card
        });

        // Initialize card data and audio paths
        let card = current_card ? {
            front_text: current_card.front_text,
            back_text: current_card.back_text,
            front_lang: current_card.front_lang || known_language,
            back_lang: current_card.back_lang || learning_language
        } : null;

        let frontAudioPath = current_card?.front_audio_path;
        let backAudioPath = current_card?.back_audio_path;

        // Track old audio paths for deletion
        const oldFrontAudioPath = current_card?.front_audio_path;
        const oldBackAudioPath = current_card?.back_audio_path;

        // Determine what needs to be regenerated
        const needsFullRegeneration = regenerate_parts.length === 0 && !card;
        const needsFrontTextRegeneration = regenerate_parts.includes('front_text');
        const needsBackTextRegeneration = regenerate_parts.includes('back_text');
        const needsFrontAudioRegeneration = regenerate_parts.includes('front_audio_path') || needsFrontTextRegeneration || needsFullRegeneration;
        const needsBackAudioRegeneration = regenerate_parts.includes('back_audio_path') || needsBackTextRegeneration || needsFullRegeneration;

        // Check text and audio generation limits BEFORE making any API calls
        const needsTextGeneration = needsFullRegeneration || needsFrontTextRegeneration || needsBackTextRegeneration;
        const audioToGenerate = (needsFrontAudioRegeneration ? 1 : 0) + (needsBackAudioRegeneration ? 1 : 0);

        // Initialize OpenAI only after we check limits

        // Check audio generation limits first (these are typically more limited)
        if (audioToGenerate > 0) {
            console.log(`Checking if user can generate ${audioToGenerate} audio files`);
            const { allowed, usage, subscription } = await checkAndIncrementUsage(
                user.id,
                'card_audio_generations_used',
                audioToGenerate
            );

            if (!allowed) {
                console.error('User has reached their audio generation limit');
                return new Response(
                    JSON.stringify({
                        error: 'You have reached your audio generation limit for this billing period'
                    }),
                    {
                        status: 403,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    }
                );
            }

            // Log detailed information about limits and usage
            console.log('Audio generation allowed - SUBSCRIPTION DETAILS:', {
                tier_id: subscription?.tier_id,
                tier_name: subscription?.subscription_tier?.name,
                current_usage: usage.card_audio_generations_used,
                tier_limit: subscription?.subscription_tier?.card_audio_generations_limit,
                tier_data: subscription?.subscription_tier
            });
        }

        // Now initialize OpenAI since we've checked limits
        console.log('Initializing OpenAI client...');
        let openai = createOpenAIClient();

        // Case 1: Complete regeneration or new card generation
        if (needsFullRegeneration) {
            console.log('Performing full card generation');

            // Generate card text
            console.log('Requesting translation from OpenAI with params:', {
                model: "gpt-4o",
                known_language,
                learning_language,
                inputLength: user_input ? user_input.length : 0
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

1. First, detect the language of this input: "${user_input}"

2. Then create a flashcard where:
   - The FRONT is ALWAYS in ${known_language}
   - The BACK is ALWAYS in ${learning_language}

3. Use these rules based on detection:
   - If input is in ${known_language}: Front = original input, Back = translation to ${learning_language}
   - If input is in ${learning_language}: Front = translation to ${known_language}, Back = original input
   - If input is in any other language: Front = translation to ${known_language}, Back = translation to ${learning_language}

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
            card = parseResult.data;
            console.log('Parsed card data:', card);
        }
        // Case 2: Regenerate only front text (translate from back text)
        else if (needsFrontTextRegeneration && !needsBackTextRegeneration && card) {
            console.log('Regenerating front text from existing back text');

            const completion = await openai.beta.chat.completions.parse({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: "You are a language translation expert. Your task is to translate text accurately while preserving the original meaning, tone, and context."
                    },
                    {
                        role: "user",
                        content: `I need a new translation for the front of my flashcard.

1. The back of my flashcard contains this text in ${card.back_lang}: "${card.back_text}"

2. Please translate it to ${card.front_lang} for the front of the card.

3. I was not satisfied with the previous translation "${card.front_text}", so please make sure your translation is accurate, natural sounding, and preserves the original meaning.

Return only a JSON with the translated front_text.`
                    }
                ],
                response_format: zodResponseFormat(
                    z.object({
                        front_text: z.string().describe("The translated text for the front of the flashcard")
                    }),
                    "front_text_translation"
                ),
            });

            const translationResult = JSON.parse(completion.choices[0]?.message?.content || '{}');
            console.log('Translation result:', translationResult);

            if (!translationResult.front_text) {
                throw new Error('Failed to get front text translation from OpenAI');
            }

            card.front_text = translationResult.front_text;
        }
        // Case 3: Regenerate only back text (translate from front text)
        else if (needsBackTextRegeneration && !needsFrontTextRegeneration && card) {
            console.log('Regenerating back text from existing front text');

            const completion = await openai.beta.chat.completions.parse({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: "You are a language translation expert. Your task is to translate text accurately while preserving the original meaning, tone, and context."
                    },
                    {
                        role: "user",
                        content: `I need a new translation for the back of my flashcard.

1. The front of my flashcard contains this text in ${card.front_lang}: "${card.front_text}"

2. Please translate it to ${card.back_lang} for the back of the card.

3. I was not satisfied with the previous translation "${card.back_text}", so please make sure your translation is accurate, natural sounding, and preserves the original meaning.

Return only a JSON with the translated back_text.`
                    }
                ],
                response_format: zodResponseFormat(
                    z.object({
                        back_text: z.string().describe("The translated text for the back of the flashcard")
                    }),
                    "back_text_translation"
                ),
            });

            const translationResult = JSON.parse(completion.choices[0]?.message?.content || '{}');
            console.log('Translation result:', translationResult);

            if (!translationResult.back_text) {
                throw new Error('Failed to get back text translation from OpenAI');
            }

            card.back_text = translationResult.back_text;
        }
        // Case 4: Regenerate both front and back text (but not as a new card)
        else if (needsFrontTextRegeneration && needsBackTextRegeneration && card) {
            console.log('Regenerating both front and back text with existing text as reference');

            const completion = await openai.beta.chat.completions.parse({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: "You are a language learning flashcard creator. Your task is to improve existing flashcards by providing better translations."
                    },
                    {
                        role: "user",
                        content: `I need both sides of my flashcard improved.

1. Current flashcard:
   - Front (${card.front_lang}): "${card.front_text}"
   - Back (${card.back_lang}): "${card.back_text}"

2. Please provide improved translations for both sides:
   - The FRONT should be in ${card.front_lang}
   - The BACK should be in ${card.back_lang}

3. The user was not satisfied with the existing translations, so please make sure your translations are accurate, natural sounding, and preserve the original meaning of "${user_input}".

Return the improved flashcard text for both sides.`
                    }
                ],
                response_format: zodResponseFormat(FlashcardSchema, "improved_flashcard"),
            });

            const rawCard = JSON.parse(completion.choices[0]?.message?.content || '{}');
            console.log('Improved card response:', completion.choices[0]?.message?.content);

            const parseResult = FlashcardSchema.safeParse(rawCard);
            if (!parseResult.success) {
                console.error('Schema validation failed:', parseResult.error);
                throw new Error('Failed to parse improved card data from OpenAI response');
            }

            // Update only the text fields, preserve language info
            card.front_text = parseResult.data.front_text;
            card.back_text = parseResult.data.back_text;
        }

        // Ensure card is not null at this point
        if (!card) {
            throw new Error('Failed to generate or retrieve card data');
        }

        // Generate front audio if needed
        if (needsFrontAudioRegeneration) {
            try {
                frontAudioPath = await processCardAudio(
                    openai,
                    supabaseClient,
                    card.front_text,
                    card.front_lang,
                    oldFrontAudioPath,
                    'front'
                );
            } catch (error) {
                throw new Error(`Failed to generate front audio: ${error.message}`);
            }
        }

        // Generate back audio if needed
        if (needsBackAudioRegeneration) {
            try {
                backAudioPath = await processCardAudio(
                    openai,
                    supabaseClient,
                    card.back_text,
                    card.back_lang,
                    oldBackAudioPath,
                    'back'
                );
            } catch (error) {
                throw new Error(`Failed to generate back audio: ${error.message}`);
            }
        }

        // Return all data at once
        return new Response(
            JSON.stringify({
                card: {
                    front_text: card.front_text,
                    back_text: card.back_text,
                    front_lang: card.front_lang,
                    back_lang: card.back_lang,
                    front_audio_path: frontAudioPath,
                    back_audio_path: backAudioPath
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