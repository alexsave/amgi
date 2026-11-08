import { answer, bodyOf } from '../../../../anki/answer';
import { readSettings } from '../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../server/anki/respond';

// Renaming a deck.
//
// Both transports rewrite every descendant too, because a subdeck in Anki is
// not a child record - it is a deck whose NAME carries its parent's as a
// prefix - and both create a missing parent when renaming into one. The
// bridge gets that from Anki's own col.decks.rename; the direct path
// implements it (plusaudio/lib/collection/decks.js) against the same rules.
export async function PATCH(request, { params }) {
  const { id } = await params;
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = bodyOf(request);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return answer({ error: 'name is required' }, { status: 400 });

  try {
    const renamed = await result.ops.renameDeck(Number(id), name);
    return answer({ mode: result.mode, ...renamed });
  } catch (error) {
    return answer({ error: error.message }, { status: 400 });
  }
}

// A failed deck read or delete as an answer: a deck that is not there (any more) is a 404, which
// the page tells apart from a refusal (the Default deck); the rest are 400, as for every route.
function failed(error) {
  const status = error.status === 404 ? 404 : 400;
  return answer({ error: status === 404 ? 'This deck no longer exists.' : error.message }, { status });
}

// What deleting the deck would take, read only: its subdecks, the cards that go and the notes left
// with no card, for the page's confirmation to name before anything is changed.
export async function GET(request, { params }) {
  const { id } = await params;
  const result = await resolveTransport(readSettings(request));
  if (!result.ops) return notReadyResponse(result.mode);
  try {
    return answer({ mode: result.mode, ...(await result.ops.deckRemovalSummary(Number(id))) });
  } catch (error) {
    return failed(error);
  }
}

// Deleting a deck, its subdecks, their cards and the notes left with no card, as Anki's own
// "Delete" in its deck list does: the bridge calls col.decks.remove, the direct transport does
// the same work (plusaudio/lib/collection/deck-remove.js), and both leave graves so a sync deletes
// the same things on every other device. Both refuse the Default deck, which Anki only empties.
export async function DELETE(request, { params }) {
  const { id } = await params;
  const result = await resolveTransport(readSettings(request));
  if (!result.ops) return notReadyResponse(result.mode);
  try {
    return answer({ mode: result.mode, ...(await result.ops.removeDeck(Number(id))) });
  } catch (error) {
    return failed(error);
  }
}
