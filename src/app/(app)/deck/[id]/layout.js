'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDecks } from '../../../../contexts/DeckContext';

// Keeps the deck in the URL and the deck in context in sync, so that
// refreshing or deep-linking a /deck/<id>/... route works instead of
// dropping the user back on the deck list.
export default function DeckLayout({ children }) {
  const { id } = useParams();
  const router = useRouter();
  const { decks, loading, currentDeckId, setCurrentDeckId } = useDecks();

  const deck = decks[id];

  useEffect(() => {
    if (deck && currentDeckId !== id) {
      setCurrentDeckId(id);
    }
  }, [deck, id, currentDeckId, setCurrentDeckId]);

  useEffect(() => {
    if (!loading && !deck) {
      router.replace('/decks');
    }
  }, [loading, deck, router]);

  if (loading || !deck || currentDeckId !== id) {
    return <div className="deck-loading">Loading deck…</div>;
  }

  return children;
}
