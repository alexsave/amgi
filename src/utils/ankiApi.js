// Thin client for /api/anki/* - the only thing on the browser side of the
// transport boundary. Every call attaches the current Anki settings (which
// profile, which bridge) as a header; the server re-resolves the real
// transport from that on every single request (see src/server/anki/transport.js).

import { loadAnkiSettings } from './ankiSettings';

async function call(path, options = {}) {
  const response = await fetch(`/api/anki${path}`, {
    ...options,
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
  generateAudio: (text, language) => call('/audio', { method: 'POST', body: JSON.stringify({ text, language }) }),
};
