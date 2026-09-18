import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDecks } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import msgpack from 'msgpack-lite';
import { PlusIcon, ArrowDownTrayIcon, Square3Stack3DIcon } from '@heroicons/react/24/outline';
import './DeckList.css';
import { NAME } from '../../constants/names';
import CreateDeckModal from './CreateDeckModal';
import StarterDeckModal from './StarterDeckModal';

const DeckList = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isStarterModalOpen, setIsStarterModalOpen] = useState(false);
  const {
    decks,
    setCurrentDeckId,
    updateDeck
  } = useDecks();
  
  const router = useRouter();
  const fileInputRef = useRef(null);

  const handleImportClick = () => {
    console.log('Import button clicked');
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    console.log('Importing file:', file.name);
    try {
      const buffer = await file.arrayBuffer();
      const deck = msgpack.decode(new Uint8Array(buffer));
      console.log('Decoded deck:', deck);
      
      const id = Date.now().toString();
      const newDeck = {
        ...deck,
        id,
        lastModified: Date.now()
      };
      
      console.log('Updating deck with ID:', id);
      updateDeck(id, newDeck);
      console.log('Setting current deck...');
      setCurrentDeckId(id);
      console.log('Navigating to deck page...');
      router.push(`/deck/${id}`);
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
        {Object.entries(decks).length === 0 ? (
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