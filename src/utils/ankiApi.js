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
  // One-button setup: copies amgi's add-ons and card type into the Anki data
  // folder. The note type itself is created by the add-on on the next profile
  // open - see src/server/anki/install.js for why that split exists.
  // baseDirOverride is passed explicitly rather than left to the saved
  // settings header: the Settings panel keeps an unsaved override in React
  // state, and installing to a folder other than the one on screen is how
  // you write add-ons into somebody's real Anki by accident.
  install: (baseDirOverride) =>
    call('/install', { method: 'POST', body: JSON.stringify({ baseDirOverride: baseDirOverride || '' }) }),
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
  // Both sides of a card plus its audio, in one request - see
  // src/server/anki/cardText.js for why text and audio are never split
  // across two calls (the reading that steers Japanese/Chinese pronunciation
  // only ever exists in this response). `includeCueAudio` also generates the
  // known-language prompt clip (CueAudio) from the same response's front_text.
  generateCardText: (userInput, knownLanguage, learningLanguage, { signal, includeCueAudio = false } = {}) =>
    call('/card-text', {
      method: 'POST',
      body: JSON.stringify({ userInput, knownLanguage, learningLanguage, includeCueAudio }),
      signal,
    }),
};
