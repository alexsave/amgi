// Deck export/import payload: pure, I/O-free functions so the file format
// and the parser can be unit tested without a browser, msgpack, or a
// Supabase connection. DeckItem/DeckList wire these to msgpack and the file
// pickers; DeckContext.importDeck wires the parsed result to Supabase.
//
// Decisions baked into this shape (see the code review / task notes for the
// full reasoning):
//
// - Cards travel with their full text and language codes. Review/scheduling
//   state never travels: importing a deck is acquiring cards to study, not
//   inheriting someone else's review history, so imported cards always start
//   as fresh "new" cards (DeckContext.importDeck creates fresh review rows).
// - ids never travel. Importing always creates a brand new deck row (and new
//   card rows) rather than merging into or overwriting an existing deck, so a
//   name collision cannot corrupt or silently blend into another deck.
// - Audio paths are bare filenames in a bucket that isn't scoped per project,
//   so a path exported from one Supabase project may not resolve in another
//   (or may happen to resolve to an unrelated object with the same name).
//   They're kept in the export for reference, but import never reads them
//   back in - imported cards always go through the normal TTS backfill path
//   instead, which already has UI for progress and failure.

export const DECK_EXPORT_FORMAT = 'amgi-deck-export';
export const DECK_EXPORT_VERSION = 1;

/**
 * Builds the plain-object payload written to an exported .bin file.
 *
 * `cards` must be the deck's FULL card list (e.g. from `loadDeckCards`), not
 * the review queue (`deck.cards` from deck context state), which is capped at
 * 40 new cards plus learning and due cards - using it silently truncates any
 * deck bigger than that cap.
 */
export function buildDeckExportPayload(deck, cards) {
  if (!deck || typeof deck.name !== 'string' || !deck.name.trim()) {
    throw new Error('Cannot export a deck without a name');
  }
  if (!deck.learning_language) {
    throw new Error('Cannot export a deck without a learning language');
  }

  return {
    format: DECK_EXPORT_FORMAT,
    version: DECK_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    deck: {
      name: deck.name,
      known_language: deck.known_language || 'en',
      learning_language: deck.learning_language
    },
    cards: (cards || []).map(card => ({
      front_text: card.front_text,
      back_text: card.back_text,
      front_lang: card.front_lang,
      back_lang: card.back_lang,
      // Reference only - see file header. Not read back in by import.
      front_audio_path: card.front_audio_path || null,
      back_audio_path: card.back_audio_path || null
    }))
  };
}

/**
 * Parses and validates a decoded import file into the shape `importDeck`
 * needs. Throws an Error whose message is safe to show the user directly.
 */
export function parseDeckImportPayload(decoded) {
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('This file is not an amgi deck export');
  }
  if (decoded.format !== DECK_EXPORT_FORMAT) {
    throw new Error('This file is not an amgi deck export');
  }
  if (decoded.version !== DECK_EXPORT_VERSION) {
    throw new Error(`This deck export is from a newer version of amgi (format v${decoded.version}) that this app cannot read`);
  }

  const deck = decoded.deck;
  if (!deck || typeof deck.name !== 'string' || !deck.name.trim()) {
    throw new Error('This deck export is missing a deck name');
  }
  if (!deck.learning_language || typeof deck.learning_language !== 'string') {
    throw new Error('This deck export is missing a learning language');
  }

  const rawCards = Array.isArray(decoded.cards) ? decoded.cards : [];
  rawCards.forEach((card, i) => {
    if (typeof card?.front_text !== 'string' || typeof card?.back_text !== 'string') {
      throw new Error(`Card ${i + 1} in this deck export is missing its text`);
    }
  });

  const known_language = typeof deck.known_language === 'string' && deck.known_language
    ? deck.known_language
    : 'en';

  return {
    deck: {
      name: deck.name,
      known_language,
      learning_language: deck.learning_language
    },
    // Audio paths are intentionally dropped here (not just left unread) so
    // there is exactly one place that decides they don't travel.
    cards: rawCards.map(card => ({
      front_text: card.front_text,
      back_text: card.back_text,
      front_lang: card.front_lang || known_language,
      back_lang: card.back_lang || deck.learning_language
    }))
  };
}

/**
 * Picks a name for an imported deck that will not collide with one this
 * account already has. Import always creates a new deck, so a name clash
 * with an existing deck must not read as "the same deck" - it gets a
 * distinguishing suffix instead.
 */
export function uniqueImportDeckName(baseName, existingNames) {
  const taken = new Set((existingNames || []).map(n => n.trim().toLowerCase()));
  const base = baseName.trim();
  if (!taken.has(base.toLowerCase())) return base;

  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (imported)` : `${base} (imported ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
