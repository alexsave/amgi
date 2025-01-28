import { useEffect, useState } from 'react';
import { useDecks } from '../contexts/DeckContext';
import msgpack from 'msgpack-lite';

export function useDeckManagement() {
  const { decks, createNewDeck, updateDeck, deleteDeck: removeDeck } = useDecks();
  const [maxNewCardsPerDay] = useState(25);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [error, setError] = useState(null);

  // Load new cards count from localStorage on mount
  useEffect(() => {
    const savedCount = localStorage.getItem('newCardsToday');
    if (savedCount) {
      setNewCardsToday(parseInt(savedCount, 10));
    }
  }, []);

  // Save new cards count to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('newCardsToday', newCardsToday.toString());
  }, [newCardsToday]);

  const handleCreateDeck = async (name) => {
    if (!name) {
      setError('Please enter a deck name');
      return;
    }

    try {
      const id = await createNewDeck(name);
      setError(null);
      return id;
    } catch (err) {
      console.error('Error creating deck:', err);
      setError('Failed to create deck');
    }
  };

  const handleDeleteDeck = (deckId) => {
    try {
      removeDeck(deckId);
      setError(null);
    } catch (err) {
      console.error('Error deleting deck:', err);
      setError('Failed to delete deck');
    }
  };

  const handleAddCardToDeck = (deckId, cardData) => {
    if (!deckId || !cardData) {
      setError('Please select a deck and generate a card first');
      return;
    }

    try {
      const deck = decks[deckId];
      if (!deck) {
        throw new Error('Deck not found');
      }

      const updatedDeck = {
        ...deck,
        cards: [...deck.cards, {
          ...cardData,
          created: Date.now(),
          lastReviewed: null,
          nextReview: Date.now(),
          interval: 0,
          repetitions: 0,
          easeFactor: 2.5
        }],
        lastModified: Date.now()
      };

      updateDeck(deckId, updatedDeck);
      setError(null);
    } catch (err) {
      console.error('Error adding card:', err);
      setError('Failed to add card');
    }
  };

  const exportDeckToFile = async (deckId, e) => {
    e.stopPropagation();
    try {
      const deck = decks[deckId];
      if (!deck) throw new Error('Deck not found');

      // Encode deck data using MessagePack for smaller file size
      const encoded = msgpack.encode(deck);
      const blob = new Blob([encoded], { type: 'application/x-msgpack' });
      
      try {
        // Use the file system access API if available
        const handle = await window.showSaveFilePicker({
          suggestedName: `${deck.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.bin`,
          types: [{
            description: 'Flashcard Deck',
            accept: {
              'application/x-msgpack': ['.bin']
            }
          }]
        });
        
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (fsErr) {
        // Only fallback if the API is not supported
        if (fsErr.name !== 'AbortError') {
          console.log('Falling back to legacy download method:', fsErr);
          const a = document.createElement('a');
          const url = URL.createObjectURL(blob);
          a.href = url;
          a.download = `${deck.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.bin`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }
    } catch (err) {
      console.error('Error exporting deck:', err);
      setError('Failed to export deck: ' + err.message);
    }
  };

  const importDeckFromFile = async (file) => {
    try {
      const buffer = await file.arrayBuffer();
      const deck = msgpack.decode(new Uint8Array(buffer));
      
      const id = Date.now().toString();
      
      createNewDeck(deck.name);
      updateDeck(id, {
        ...deck,
        lastModified: Date.now()
      });
      setError(null);
    } catch (err) {
      console.error('Error importing deck:', err);
      setError('Failed to import deck: ' + err.message);
    }
  };

  return {
    decks,
    maxNewCardsPerDay,
    newCardsToday,
    error,
    createDeck: handleCreateDeck,
    deleteDeck: handleDeleteDeck,
    addCardToDeck: handleAddCardToDeck,
    setNewCardsToday,
    setError,
    exportDeckToFile,
    importDeckFromFile
  };
} 