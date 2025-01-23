import { useState, useEffect } from 'react';
import { useDeckContext } from '../contexts/DeckContext';
import msgpack from 'msgpack-lite';

export function useDeckManagement() {
  const { decks, setDecks, currentDeck, setCurrentDeck } = useDeckContext();
  const [maxNewCardsPerDay] = useState(25);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [error, setError] = useState(null);

  // Load all data from localStorage on mount
  useEffect(() => {
    const savedDecks = localStorage.getItem('decks');
    const savedNewCardsToday = localStorage.getItem('newCardsToday');
    const lastReviewDate = localStorage.getItem('lastReviewDate');
    const today = new Date().toISOString().split('T')[0];

    // Load decks
    if (savedDecks) {
      try {
        const decoded = JSON.parse(savedDecks);
        setDecks(decoded);
        
        const lastDeckId = localStorage.getItem('currentDeck');
        if (lastDeckId && decoded[lastDeckId]) {
          setCurrentDeck(lastDeckId);
        }
      } catch (err) {
        console.error('Error loading decks:', err);
      }
    }

    // Reset new cards count if it's a new day
    if (lastReviewDate !== today) {
      setNewCardsToday(0);
      localStorage.setItem('lastReviewDate', today);
      localStorage.setItem('newCardsToday', '0');
    } else {
      // Load saved new cards count
      setNewCardsToday(parseInt(savedNewCardsToday || '0', 10));
    }
  }, []);

  // Save new cards count whenever it changes
  useEffect(() => {
    localStorage.setItem('newCardsToday', newCardsToday.toString());
  }, [newCardsToday]);

  // Save decks to localStorage whenever they change
  useEffect(() => {
    if (Object.keys(decks).length > 0) {
      localStorage.setItem('decks', JSON.stringify(decks));
      if (currentDeck) {
        localStorage.setItem('currentDeck', currentDeck);
      }
    }
  }, [decks, currentDeck]);

  const createNewDeck = () => {
    const name = prompt('Enter deck name:');
    if (name) {
      const id = Date.now().toString();
      const newDeck = {
        name,
        cards: [],
        created: Date.now(),
        lastModified: Date.now()
      };
      
      setDecks(prev => ({
        ...prev,
        [id]: newDeck
      }));
      setCurrentDeck(id);
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
      
      setDecks(prev => ({
        ...prev,
        [id]: {
          ...deck,
          lastModified: Date.now()
        }
      }));
      
      setCurrentDeck(id);
      setError(null);
    } catch (err) {
      console.error('Error importing deck:', err);
      setError('Failed to import deck: ' + err.message);
    }
  };

  const deleteDeck = (deckId, e) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this deck?')) {
      setDecks(prev => {
        const newDecks = { ...prev };
        delete newDecks[deckId];
        return newDecks;
      });
      if (currentDeck === deckId) {
        setCurrentDeck(null);
      }
    }
  };

  const addCardToDeck = async (cardData) => {
    if (!currentDeck || !cardData) {
      setError('Please select a deck and generate a card first');
      return;
    }

    try {
      setDecks(prev => ({
        ...prev,
        [currentDeck]: {
          ...prev[currentDeck],
          cards: [...prev[currentDeck].cards, {
            ...cardData,
            created: Date.now(),
            interval: 1,
            easeFactor: 2.5,
            repetitions: 0,
            lastReviewed: null,
            nextReview: new Date().toISOString().split('T')[0]
          }],
          lastModified: Date.now()
        }
      }));

      setError(null);
    } catch (err) {
      console.error('Error adding card to deck:', err);
      setError('Failed to add card to deck: ' + err.message);
    }
  };

  return {
    maxNewCardsPerDay,
    newCardsToday,
    setNewCardsToday,
    error,
    setError,
    createNewDeck,
    exportDeckToFile,
    importDeckFromFile,
    deleteDeck,
    addCardToDeck
  };
} 