import React, { useEffect, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import { PlusIcon } from '@heroicons/react/24/outline';
import './DeckList.css';
import CreateDeckModal from './CreateDeckModal';
import { ANKI_READY_MODES, ankiModePresentation } from '../../utils/ankiModeText';
import FirstRun from '../Setup/FirstRun';
import { ankiApi } from '../../utils/ankiApi';

const DeckList = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { decks, loading, ankiStatus } = useDecks();
  const ready = ANKI_READY_MODES.has(ankiStatus?.mode);
  // null while unknown, so a slow answer shows the deck list rather than
  // flashing the setup screen at someone who set up months ago.
  const [installed, setInstalled] = useState(null);

  useEffect(() => {
    let live = true;
    ankiApi.installState()
      .then((state) => { if (live) setInstalled(state.installed); })
      .catch(() => { if (live) setInstalled(true); });
    return () => { live = false; };
  }, [ankiStatus?.mode]);

  const emptyState = () => {
    // An empty deck list because Anki is locked, unconfigured, or otherwise
    // unreachable is a completely different situation from a genuinely
    // fresh collection with no decks yet - showing "create your first deck"
    // for the former would look like data loss instead of the mode the
    // navbar badge is already naming. Say the same thing here, not "create
    // one" as if nothing was wrong.
    // Never set up on this machine at all is not an error state, it is the
    // beginning - so it gets the setup screen rather than a sentence
    // pointing at Settings. Every other not-ready mode IS something going
    // wrong with a collection that was working, and still explains itself.
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

  // Setup is the entire screen, not an empty state inside the deck list:
  // "Decks" and a New Deck button above a machine that cannot make one yet
  // is chrome for a thing that does not exist.
  if (installed === false || ankiStatus?.mode === 'unconfigured') {
    return <div className="deck-management"><FirstRun /></div>;
  }

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
        {/* Not ready wins over whatever decks are still in state. Anki
            opening mid-session used to leave the last-known list on screen
            under an "Anki locked" badge: every row was unclickable, creating
            a deck would fail, and the only hint was a badge most people are
            not looking at. Saying plainly that the collection cannot be read
            right now is both more honest and more useful than a list you
            cannot act on. */}
        {!ready ? (
          emptyState()
        ) : loading ? (
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
