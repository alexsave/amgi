import React from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { useRouter } from 'next/navigation';
import './DeckItem.css';

// Deleting a deck isn't something either Anki transport exposes yet
// (plusaudio/lib/collection and the HTTP bridge can create decks, but not
// remove them) - Anki's own deck list already does this, so there is
// nothing to wire up here rather than something left broken.
const DeckItem = ({ id, deck }) => {
  const { setCurrentDeckId } = useDecks();
  const router = useRouter();

  const handleDeckClick = () => {
    setCurrentDeckId(id);
    router.push(`/deck/${id}`);
  };

  return (
    <div
      className="deck-item"
      onClick={handleDeckClick}
    >
      <div className="deck-info">
        <h3>{deck.name}</h3>
        <small>{deck.noteCount} note{deck.noteCount === 1 ? '' : 's'}</small>
      </div>
    </div>
  );
};

export default DeckItem;
