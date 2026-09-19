import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDecks } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import msgpack from 'msgpack-lite';
import { PlusIcon, ArrowDownTrayIcon, Square3Stack3DIcon } from '@heroicons/react/24/outline';
import { parseDeckImportPayload } from '../../utils/deckExport';
import './DeckList.css';
import { NAME } from '../../constants/names';
import CreateDeckModal from './CreateDeckModal';
import StarterDeckModal from './StarterDeckModal';

const DeckList = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isStarterModalOpen, setIsStarterModalOpen] = useState(false);
  const {
    decks,
    loading,
    setCurrentDeckId,
    importDeck
  } = useDecks();

  const router = useRouter();
  const fileInputRef = useRef(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    // Cleared unconditionally so re-selecting the same file after a failed
    // import still fires onChange.
    event.target.value = '';
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const decoded = msgpack.decode(new Uint8Array(buffer));
      const payload = parseDeckImportPayload(decoded);
      const deckId = await importDeck(payload);
      setCurrentDeckId(deckId);
      router.push(`/deck/${deckId}`);
    } catch (err) {
      console.error('Error importing deck:', err);
      alert('Failed to import deck: ' + err.message);
    }
  };

  return (
    <div className="deck-management">
      <div className="deck-header">
        <h2>Decks</h2>
        <div className="deck-actions">
          <button onClick={() => setIsCreateModalOpen(true)} className="action-btn" title="New Deck">
            <PlusIcon />
          </button>
          <input
            type="file"
            accept=".bin"
            onChange={handleFileSelect}
            ref={fileInputRef}
            style={{ display: 'none' }}
          />
          <button onClick={handleImportClick} className="action-btn" title="Import Deck">
            <ArrowDownTrayIcon />
          </button>
          <button onClick={() => setIsStarterModalOpen(true)} className="action-btn" title="Starter Decks">
            <Square3Stack3DIcon />
          </button>
        </div>
      </div>

      <CreateDeckModal
        isOpen={isCreateModalOpen}
        setIsCreateModalOpen={setIsCreateModalOpen}
      />

      <StarterDeckModal
        isOpen={isStarterModalOpen}
        onClose={() => setIsStarterModalOpen(false)}
      />
      
      <div className="deck-list">
        {loading ? (
          // Without this, the first paint of a signed-in user's deck list is
          // the "you have no decks" pitch, which then flips to their decks.
          <div className="deck-list-loading">Loading your decks…</div>
        ) : Object.entries(decks).length === 0 ? (
          <div className="empty-deck-state">
            <button
              onClick={() => setIsStarterModalOpen(true)}
              className="create-first-deck-btn"
            >
              <Square3Stack3DIcon style={{height: '20px', width: '20px'}}/>
              <span>Start with a ready-made phrase deck</span>
            </button>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="create-first-deck-btn"
            >
              <PlusIcon style={{height: '20px', width: '20px'}}/>
              <span>Create your first {NAME} deck</span>
            </button>
          </div>
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
}

export default DeckList; 