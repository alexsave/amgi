import React, { useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import { PlusIcon } from '@heroicons/react/24/outline';
import './DeckList.css';
import CreateDeckModal from './CreateDeckModal';
import { ANKI_READY_MODES, ankiModePresentation } from '../../utils/ankiModeText';

const DeckList = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { decks, loading, ankiStatus } = useDecks();
  const ready = ANKI_READY_MODES.has(ankiStatus?.mode);

  const emptyState = () => {
    // An empty deck list because Anki is locked, unconfigured, or otherwise
    // unreachable is a completely different situation from a genuinely
    // fresh collection with no decks yet - showing "create your first deck"
    // for the former would look like data loss instead of the mode the
    // navbar badge is already naming. Say the same thing here, not "create
    // one" as if nothing was wrong.
    if (!ready) {
      const presentation = ankiModePresentation(ankiStatus?.mode);
      return (
        <div className="empty-deck-state">
          <p style={{ maxWidth: '32rem', textAlign: 'center', color: 'var(--text-secondary)' }}>{presentation.title}</p>
        </div>
      );
    }
    return (
      <div className="empty-deck-state">
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="create-first-deck-btn"
        >
          <PlusIcon style={{ height: '20px', width: '20px' }} />
          <span>Create your first deck</span>
        </button>
      </div>
    );
  };

  return (
    <div className="deck-management">
      <div className="deck-header">
        <h2>Decks</h2>
        <div className="deck-actions">
          <button onClick={() => setIsCreateModalOpen(true)} className="action-btn" title="New Deck">
            <PlusIcon />
          </button>
        </div>
      </div>

      <CreateDeckModal
        isOpen={isCreateModalOpen}
        setIsCreateModalOpen={setIsCreateModalOpen}
      />

      <div className="deck-list">
        {loading ? (
          <div className="deck-list-loading">Loading your decks…</div>
        ) : Object.entries(decks).length === 0 ? (
          emptyState()
        ) : (
          Object.values(decks).map((deck) => (
            <DeckItem
              key={deck.id}
              id={deck.id}
              deck={deck}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default DeckList;
