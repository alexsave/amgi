import { NextResponse } from 'next/server';
import { readSettings } from '../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../server/anki/respond';

// Writing a whole paste's worth of notes in one call - see
// bridgeClient.js/directClient.js's addNotesBulk and, on the bridge side,
// bridge_ops.add_notes_bulk's module comment for why this exists as its own
// endpoint rather than the bulk-add screen just calling POST /notes in a
// loop: under the bridge transport a loop would open and close 60 separate
// CollectionOps on Anki's main thread (slow, and 60 UI repaints for one
// user action), where this is exactly one.
export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const { notes } = body || {};
  if (!Array.isArray(notes) || notes.length === 0) {
    return NextResponse.json({ error: 'notes must be a non-empty array' }, { status: 400 });
  }
  for (const note of notes) {
    if (!note?.deckId || !note?.notetypeId || !Array.isArray(note?.fields)) {
      return NextResponse.json({ error: 'each note requires deckId, notetypeId and fields' }, { status: 400 });
    }
  }

  try {
    const results = await result.ops.addNotesBulk(notes);
    return NextResponse.json({ mode: result.mode, results });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
