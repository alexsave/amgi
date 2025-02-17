import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDecks } from '../../contexts/DeckContext';
import DeckItem from './DeckItem';
import { sampleDeck } from '../../sampleDeck';
import msgpack from 'msgpack-lite';
import { PlusIcon, ArrowDownTrayIcon, Square3Stack3DIcon } from '@heroicons/react/24/outline';
import './DeckList.css';
import { NAME } from '../../constants/names';
import CreateDeckModal from './CreateDeckModal';

const DeckList = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { 
    decks,
    createNewDeck,
    setCurrentDeck,
    updateDeck
  } = useDecks();
  
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const handleCreateDeck = async (name) => {
    console.log('Creating new deck with name:', name);
    try {
      console.log('Calling createNewDeck...');
      const id = await createNewDeck(name);
      console.log('Created deck with ID:', id);
      
      setIsCreateModalOpen(false);
      console.log('Navigating to deck page...');
      navigate(`/deck/${id}`);
    } catch (error) {
      console.error('Error creating deck:', error);
      alert('Failed to create deck: ' + error.message);
    }
  };


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
      setCurrentDeck(id);
      console.log('Navigating to deck page...');
      navigate(`/deck/${id}`);
    } catch (err) {
      console.error('Error importing deck:', err);
      alert('Failed to import deck: ' + err.message);
    }
  };

  const loadSampleDeck = () => {
    console.log('Loading sample deck');
    const id = Date.now().toString();
    const newDeck = {
      ...sampleDeck,
      id,
      lastModified: Date.now()
    };
    
    console.log('Updating deck with ID:', id);
    updateDeck(id, newDeck);
    console.log('Setting current deck...');
    setCurrentDeck(id);
    console.log('Navigating to deck page...');
    navigate(`/deck/${id}`);
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
          <button onClick={loadSampleDeck} className="action-btn" title="Load Sample Deck">
            <Square3Stack3DIcon />
          </button>
        </div>
      </div>
      
      <CreateDeckModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateDeck}
      />
      
      <div className="deck-list">
        {Object.entries(decks).length === 0 ? (
          <div className="empty-deck-state">
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