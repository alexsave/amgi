// Where amgi remembers, per deck, which language a person already knows and
// which they are learning - entirely in this browser's localStorage, the
// same place ankiSettings.js keeps its own state and for the same reason:
// there is no server-side account to hold this, and an Anki deck carries no
// language metadata of its own (it is just a name and a note type), so
// nothing about the pair can be read back from the collection itself.
// Keyed by the deck's own Anki id, so switching decks in the add-note screen
// switches the remembered pair with it instead of leaking one deck's
// languages into another's.

const STORAGE_KEY_PREFIX = 'amgi:deck-languages:';

export const DEFAULT_DECK_LANGUAGES = Object.freeze({ known: 'en', learning: 'ko' });

export function loadDeckLanguages(deckId) {
  if (typeof window === 'undefined' || deckId === null || deckId === undefined) return DEFAULT_DECK_LANGUAGES;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${deckId}`);
    if (!raw) return DEFAULT_DECK_LANGUAGES;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_DECK_LANGUAGES, ...parsed };
  } catch {
    return DEFAULT_DECK_LANGUAGES;
  }
}

export function saveDeckLanguages(deckId, languages) {
  if (typeof window === 'undefined' || deckId === null || deckId === undefined) return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${deckId}`, JSON.stringify(languages));
  } catch {
    // Storage unavailable (private browsing, quota) - the pair just won't be
    // remembered next time; nothing to add to a card fails because of this.
  }
}
