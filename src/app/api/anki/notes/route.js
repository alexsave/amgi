import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';

export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const { deckId, notetypeId, fields, tags = [] } = body || {};
  if (!deckId || !notetypeId || !Array.isArray(fields)) {
    return NextResponse.json({ error: 'deckId, notetypeId and fields are required' }, { status: 400 });
  }

  try {
    const added = await result.ops.addNote({ deckId, notetypeId, fields, tags });
    return NextResponse.json({ mode: result.mode, ...added });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
