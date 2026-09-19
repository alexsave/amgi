import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';

export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const { deckId, notetypeId, fields, tags = [], language, learningFieldIndex } = body || {};
  if (!deckId || !notetypeId || !Array.isArray(fields)) {
    return NextResponse.json({ error: 'deckId, notetypeId and fields are required' }, { status: 400 });
  }

  try {
    // language/learningFieldIndex are optional: they only feed the
    // romanisation guard (see plusaudio/lib/cardGeneration/cardText.ts's
    // looksRomanized) and are omitted entirely when the caller does not send
    // them, same as before that guard existed.
    const added = await result.ops.addNote({ deckId, notetypeId, fields, tags, language, learningFieldIndex });
    return NextResponse.json({ mode: result.mode, ...added });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
