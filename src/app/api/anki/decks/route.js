import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';

export async function GET(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const decks = await result.ops.listDecks();
  // One extra small query per deck rather than a heavier join, so the deck
  // list still costs nothing per note - see countNotesInDeck's own comment
  // in plusaudio/lib/collection/notes.js for why this is cheap even on a
  // large collection.
  const withCounts = await Promise.all(
    decks.map(async (deck) => ({ ...deck, noteCount: await result.ops.countNotesInDeck(deck.id) })),
  );
  return NextResponse.json({ mode: result.mode, decks: withCounts });
}

export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const name = (body?.name || '').trim();
  if (!name) return NextResponse.json({ error: 'a deck name is required' }, { status: 400 });

  try {
    const created = await result.ops.createDeck(name);
    return NextResponse.json({ mode: result.mode, ...created });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
