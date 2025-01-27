import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDeckContext } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import { sampleDeck } from '../../sampleDeck';
import msgpack from 'msgpack-lite';
import { PlusIcon, ArrowDownTrayIcon, Square3Stack3DIcon } from '@heroicons/react/24/outline';
import './DeckList.css';

const DeckList = () => {
  const { 
    decks,
    createNewDeck,
    setCurrentDeck,
    setDecks
  } = useDeckContext();
  
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const handleCreateDeck = async () => {
    const name = prompt('Enter deck name:');
    if (name) {
      const id = await createNewDeck(name);
      navigate(`/deck/${id}`);
    }
  };

  const handleDeckClick = (id) => {
    setCurrentDeck(id);
    navigate(`/deck/${id}/review`);
  };

  const handleEditClick = (e, id) => {
    e.stopPropagation();
    setCurrentDeck(id);
    navigate(`/deck/${id}`);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const deck = msgpack.decode(new Uint8Array(buffer));
      
      const id = Date.now().toString();
      setDecks(prev => ({
        ...prev,
        [id]: {
          ...deck,
          lastModified: Date.now()
        }
      }));
      
      setCurrentDeck(id);
      navigate(`/deck/${id}`);
    } catch (err) {
      console.error('Error importing deck:', err);
      alert('Failed to import deck: ' + err.message);
    }
  };

  const loadSampleDeck = () => {
    const id = Date.now().toString();
    setDecks(prev => ({
      ...prev,
      [id]: sampleDeck
    }));
    setCurrentDeck(id);
    navigate(`/deck/${id}`);
  };

  return (
    <div className="deck-management">
      <div className="deck-header">
        <h2>Decks</h2>
        <div className="deck-actions">
          <button onClick={handleCreateDeck} className="action-btn" title="New Deck">
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
          <button onClick={loadSampleDeck} className="action-btn" title="Load Sample Deck">
            <Square3Stack3DIcon />
          </button>
        </div>
      </div>
      
      <div className="deck-list">
        {Object.entries(decks).map(([id, deck]) => (
          <DeckItem
            key={id}
            id={id}
            deck={deck}
            onDeckClick={() => handleDeckClick(id)}
            onEditClick={(e) => handleEditClick(e, id)}
          />
        ))}
      </div>
    </div>
  );
}

export default DeckList; 