// Deleting cards (or a whole deck) together with the audio that nothing else
// references any more.
//
// This has to run server-side with the service role. Card audio is uploaded by
// the service role in the `cards` function, which leaves
// `storage.objects.owner` null, so the bucket's delete policy
// (`auth.uid() = owner`) can never match for a signed-in browser: a client
// `remove()` returns `{ data: [], error: null }` and quietly deletes nothing.
// See supabase/migrations/20260918150000_card_audio_gc.sql for why the row
// delete and the "is it still referenced?" check live in one SQL function.
//
// Order matters: the rows go first, then the objects. A failure in between
// leaves an unreferenced object (recoverable by a sweep) rather than a card
// row pointing at audio that no longer exists (not recoverable at all).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const CARD_AUDIO_BUCKET = 'card-audio';

export interface DeleteCardsRequest {
  userId: string;
  cardIds?: string[];
  deckId?: string;
}

export interface DeleteCardsResult {
  /** Objects that were removed from the bucket. */
  deletedAudio: string[];
  /** Objects that became unreferenced but were not in the bucket to remove. */
  missingAudio: string[];
}

/**
 * Deletes the given cards, or an entire deck, and removes every audio object
 * that no remaining card row references. Shared audio (a translation pair
 * points its two rows at the same two objects) survives until the last row
 * referencing it is gone.
 */
export async function deleteCardsAndAudio(
  admin: SupabaseClient,
  { userId, cardIds, deckId }: DeleteCardsRequest,
): Promise<DeleteCardsResult> {
  if (deckId && cardIds?.length) {
    throw new Error('Pass either deck_id or card_ids, not both');
  }

  const { data, error } = deckId
    ? await admin.rpc('delete_deck_returning_orphaned_audio', { p_user_id: userId, p_deck_id: deckId })
    : await admin.rpc('delete_cards_returning_orphaned_audio', { p_user_id: userId, p_card_ids: cardIds ?? [] });

  if (error) throw new Error(`Failed to delete cards: ${error.message}`);

  const orphaned: string[] = (data ?? []) as string[];
  if (orphaned.length === 0) return { deletedAudio: [], missingAudio: [] };

  const { data: removed, error: removeError } = await admin.storage
    .from(CARD_AUDIO_BUCKET)
    .remove(orphaned);

  if (removeError) throw new Error(`Deleted the cards but could not remove their audio: ${removeError.message}`);

  // `remove()` reports success even when it deleted nothing, so the only
  // honest confirmation is the list of objects it says it took.
  const deletedAudio = (removed ?? []).map((object) => object.name);
  const missingAudio = orphaned.filter((path) => !deletedAudio.includes(path));

  return { deletedAudio, missingAudio };
}
