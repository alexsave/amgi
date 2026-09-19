import { NextResponse } from 'next/server';
import { readSettings } from '../../../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../../../server/anki/respond';

// What the bulk-add-from-paste screen checks a pasted line against before
// writing it: every value already sitting in one field, for one note type,
// in one deck (see plusaudio/lib/collection/notes.js's noteFieldValuesInDeck
// and bridge_ops.py's list_field_values for why this is one query rather
// than a per-line lookup - the cheapest correct check is "fetch the whole
// set once, dedupe client-side with the same normalization used within the
// paste itself").
export async function GET(request, { params }) {
  const { id } = await params;
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const url = new URL(request.url);
  const notetypeId = Number(url.searchParams.get('notetypeId'));
  const fieldIndex = Number(url.searchParams.get('fieldIndex'));
  if (!Number.isInteger(notetypeId) || !Number.isInteger(fieldIndex)) {
    return NextResponse.json({ error: 'notetypeId and fieldIndex are required' }, { status: 400 });
  }

  const values = await result.ops.existingFieldValues(Number(id), notetypeId, fieldIndex);
  return NextResponse.json({ mode: result.mode, values });
}
