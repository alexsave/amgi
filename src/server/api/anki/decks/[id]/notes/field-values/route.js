import { answer } from '../../../../../../anki/answer';
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
  const url = new URL(request.url);
  const notetypeId = wholeNumber(url.searchParams.get('notetypeId'));
  const fieldIndex = wholeNumber(url.searchParams.get('fieldIndex'));
  if (notetypeId === null || fieldIndex === null) {
    const which = [notetypeId === null && 'notetypeId', fieldIndex === null && 'fieldIndex'].filter(Boolean).join(' and ');
    return answer({ error: `${which} must be given, as a whole number` }, { status: 400 });
  }
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const values = await result.ops.existingFieldValues(Number(id), notetypeId, fieldIndex);
  return answer({ mode: result.mode, values });
}

// A query parameter that is a whole number written in digits, or null: missing, empty, signed,
// fractional or anything else is not one (Number() would read a missing one as 0).
function wholeNumber(text) {
  return text !== null && /^[0-9]+$/.test(text) ? Number(text) : null;
}
