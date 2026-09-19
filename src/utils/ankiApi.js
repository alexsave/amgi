// Thin client for /api/anki/* - the only thing on the browser side of the
// transport boundary. Every call attaches the current Anki settings (which
// profile, which bridge) as a header; the server re-resolves the real
// transport from that on every single request (see src/server/anki/transport.js).

import { loadAnkiSettings } from './ankiSettings';

async function call(path, options = {}) {
  const { signal, ...rest } = options;
  const response = await fetch(`/api/anki${path}`, {
    ...rest,
    signal,
    headers: {
      'X-Amgi-Anki-Settings': JSON.stringify(loadAnkiSettings()),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `request to ${path} failed (${response.status})`);
    error.mode = data.mode;
    error.status = response.status;
    throw error;
  }
  return data;
}

export const ankiApi = {
  status: () => call('/status'),
  profiles: () => call('/profiles'),
  decks: () => call('/decks'),
  createDeck: (name) => call('/decks', { method: 'POST', body: JSON.stringify({ name }) }),
  notetypes: () => call('/notetypes'),
  notesInDeck: (deckId, { offset = 0, limit = 50 } = {}) =>
    call(`/decks/${deckId}/notes?offset=${offset}&limit=${limit}`),
  addNote: (note) => call('/notes', { method: 'POST', body: JSON.stringify(note) }),
  // The bulk-add-from-paste screen's write path (see BulkAddForm.js) - one
  // request for the whole batch so the bridge transport can run it as one
  // CollectionOp instead of one per line (see notes/bulk/route.js).
  addNotesBulk: (notes) => call('/notes/bulk', { method: 'POST', body: JSON.stringify({ notes }) }),
  updateNote: (noteId, fields, { language, learningFieldIndex } = {}) =>
    call(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ fields, language, learningFieldIndex }) }),
  // Every value already in one field of one note type in a deck - the
  // bulk-add-vs-deck dupe check (see src/utils/lyricsParse.js's
  // existingKeySet for how the response is turned into a comparable set).
  fieldValuesInDeck: (deckId, notetypeId, fieldIndex) =>
    call(`/decks/${deckId}/notes/field-values?notetypeId=${notetypeId}&fieldIndex=${fieldIndex}`),
  generateAudio: (text, language, { signal } = {}) =>
    call('/audio', { method: 'POST', body: JSON.stringify({ text, language }), signal }),
};
