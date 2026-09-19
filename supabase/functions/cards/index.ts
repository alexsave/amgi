/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage, refundUsage } from "../_shared/billing.ts";
import { CARD_MODELS, createOpenAIClient } from "../_shared/openai.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { normalizeLanguageCode } from "../_shared/cardText.ts";
import {
    cardTextMode,
    generateCardAudio,
    generateCardText,
    type CardGenerationContext,
} from "../_shared/cardGeneration.ts";

// What a card is made of - prompts, schemas, assembly, the audio validation
// loop - lives in ../_shared/cardGeneration.ts, because the plusaudio CLI
// builds decks with the same policy and a second copy of it would quietly
// become a worse one. What stays here is what only this function can do:
// authenticate the caller, charge and refund their quota, put the audio in
// storage, and answer over HTTP.

/**
 * Handles the complete audio generation process for a card side
 * including validation, old file cleanup, and storage
 */
async function processCardAudio(
    ctx: CardGenerationContext,
    text: string,
    language: string,
    oldAudioPath: string | undefined,
    side: 'front' | 'back',
    reading = ''
): Promise<string> {
    const audioBuffer = await generateCardAudio(ctx, { text, language, reading });

    // Delete old audio if it exists; failure to clean up shouldn't fail the request.
    if (oldAudioPath) {
        const { error: deleteError } = await supabaseAdmin.storage
            .from('card-audio')
            .remove([oldAudioPath]);
        if (deleteError) {
            console.warn(`Could not delete old ${side} audio ${oldAudioPath}:`, deleteError.message);
        }
    }

    const audioPath = `${Date.now()}_${side}_${crypto.randomUUID().slice(0, 8)}.mp3`;
    const { error } = await supabaseAdmin.storage
        .from('card-audio')
        .upload(audioPath, audioBuffer, {
            contentType: 'audio/mpeg',
            cacheControl: '3600'
        });

    if (error) {
        throw new Error(`Failed to upload ${side} audio: ${error.message}`);
    }

    return audioPath;
}

Deno.serve(wrapRequest(async ({ user, body }) => {
    const {
        user_input,
        known_language,
        learning_language,
        regenerate_parts = [],
        current_card = null
    } = body as {
        user_input?: string;
        known_language?: string;
        learning_language?: string;
        regenerate_parts?: string[];
        current_card?: Record<string, string> | null;
    };

    // The direction is fixed by the deck, not by the model: the front is the
    // language the learner already speaks, the back the one they are learning.
    const frontLang = normalizeLanguageCode(known_language || current_card?.front_lang || 'en') || 'en';
    const backLang = normalizeLanguageCode(learning_language || current_card?.back_lang || 'en') || 'en';

    const frontAudioPathIn = current_card?.front_audio_path;
    const backAudioPathIn = current_card?.back_audio_path;

    // Determine what needs to be regenerated
    const textMode = cardTextMode(regenerate_parts, Boolean(current_card));
    const needsFullRegeneration = textMode === 'generate';
    const needsFrontTextRegeneration = regenerate_parts.includes('front_text');
    const needsBackTextRegeneration = regenerate_parts.includes('back_text');
    const needsFrontAudioRegeneration = regenerate_parts.includes('front_audio_path') || needsFrontTextRegeneration || needsFullRegeneration;
    const needsBackAudioRegeneration = regenerate_parts.includes('back_audio_path') || needsBackTextRegeneration || needsFullRegeneration;

    // Reject empty generation requests before any billing or API calls.
    // (wrapRequest tolerates a missing body, so this is the real gate.)
    if (needsFullRegeneration && !user_input?.trim()) {
        throw new Error('user_input is required to generate a card');
    }

    // Check audio generation limits BEFORE making any API calls
    const audioToGenerate = (needsFrontAudioRegeneration ? 1 : 0) + (needsBackAudioRegeneration ? 1 : 0);

    if (audioToGenerate > 0) {
        const { allowed } = await checkAndIncrementUsage(
            user.id,
            'card_audio_generations_used',
            audioToGenerate
        );

        if (!allowed) {
            throw new HttpError('You have reached your audio generation limit for this billing period', 403);
        }
    }

    const ctx: CardGenerationContext = {
        openai: createOpenAIClient(),
        models: CARD_MODELS,
    };

    const card = await generateCardText(ctx, {
        userInput: user_input || '',
        knownLanguage: frontLang,
        learningLanguage: backLang,
        currentCard: current_card
            ? {
                front_text: current_card.front_text,
                back_text: current_card.back_text,
                // Not a card column: the client hands back whatever the last
                // generation returned, so regenerating only the audio of a
                // card still in the modal keeps its reading.
                spoken_reading: current_card.spoken_reading || '',
            }
            : null,
        regenerateParts: regenerate_parts,
    });

    // The two sides are independent - generate them concurrently. If audio
    // generation ultimately fails, refund the pre-charged quota.
    let frontAudioPath: string | undefined;
    let backAudioPath: string | undefined;
    try {
        [frontAudioPath, backAudioPath] = await Promise.all([
            needsFrontAudioRegeneration
                ? processCardAudio(ctx, card.front_text, frontLang, frontAudioPathIn, 'front')
                : Promise.resolve(frontAudioPathIn),
            needsBackAudioRegeneration
                ? processCardAudio(ctx, card.back_text, backLang, backAudioPathIn, 'back', card.spoken_reading)
                : Promise.resolve(backAudioPathIn),
        ]);
    } catch (audioError) {
        if (audioToGenerate > 0) {
            await refundUsage(user.id, 'card_audio_generations_used', audioToGenerate);
        }
        throw audioError;
    }

    return {
        card: {
            front_text: card.front_text,
            back_text: card.back_text,
            front_lang: frontLang,
            back_lang: backLang,
            front_audio_path: frontAudioPath,
            back_audio_path: backAudioPath,
            // Not a card column: it exists so a follow-up request in the same
            // modal session can still check the reading of the back audio.
            spoken_reading: card.spoken_reading
        }
    };
}));
