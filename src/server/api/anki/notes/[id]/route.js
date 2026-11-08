import { answer, bodyOf } from '../../../../anki/answer';
import { readSettings } from '../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../server/anki/respond';

// Replacing a note's field contents in place - already supported at the
// collection/bridge layer (Collection.updateNote, bridge_ops.update_note,
// PATCH /notes/:id on the bridge) but never wired up through this app's own
// HTTP surface until the audio-generation follow-up pass needed it: writing
// a clip into a note that was added moments ago, by a bulk paste, without
// regenerating the note itself.
export async function PATCH(request, { params }) {
  const { id } = await params;
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = bodyOf(request);
  const { fields, language, learningFieldIndex } = body || {};
  if (!Array.isArray(fields)) {
    return answer({ error: 'fields is required' }, { status: 400 });
  }

  try {
    const updated = await result.ops.updateNote(Number(id), fields, language, learningFieldIndex);
    return answer({ mode: result.mode, noteId: Number(id), ...updated });
  } catch (error) {
    return answer({ error: error.message }, { status: 400 });
  }
}

// Deleting a note and its cards. This writes to a collection that syncs, so
// it is not a row delete: both transports leave graves behind (the direct one
// by hand, the bridge by calling Anki's own col.remove_notes), or AnkiWeb
// pushes the note straight back on the next sync.
export async function DELETE(request, { params }) {
  const { id } = await params;
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  try {
    const removed = await result.ops.removeNote(Number(id));
    return answer({ mode: result.mode, noteId: Number(id), ...removed });
  } catch (error) {
    return answer({ error: error.message }, { status: 400 });
  }
}
