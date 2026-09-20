import { NextResponse } from 'next/server';
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

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  try {
    const renamed = await result.ops.renameDeck(Number(id), name);
    return NextResponse.json({ mode: result.mode, ...renamed });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
