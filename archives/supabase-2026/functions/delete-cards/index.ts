/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequest } from "../_shared/handler.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { deleteCardsAndAudio } from "../_shared/cardDeletion.ts";

// Deletes cards (`card_ids`) or a whole deck (`deck_id`) and garbage-collects
// the audio they leave behind. Lives in an edge function because removing the
// objects needs the service role - see _shared/cardDeletion.ts.
Deno.serve(wrapRequest(async ({ user, body }) => {
    const { card_ids, deck_id } = body as { card_ids?: string[]; deck_id?: string };

    if (!deck_id && !card_ids?.length) {
        throw new Error('Nothing to delete: pass card_ids or deck_id');
    }

    const { deletedAudio, missingAudio } = await deleteCardsAndAudio(supabaseAdmin, {
        userId: user.id,
        cardIds: card_ids,
        deckId: deck_id,
    });

    if (missingAudio.length > 0) {
        // The rows are already gone, so this is not worth failing the request
        // over, but it means the bucket and the cards table disagreed.
        console.error('Unreferenced audio was not in the bucket:', missingAudio.join(', '));
    }

    return { deleted_audio: deletedAudio, missing_audio: missingAudio };
}));
