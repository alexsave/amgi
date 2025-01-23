import React from 'react';
import { useState, useEffect } from 'react';
import msgpack from 'msgpack-lite';
import vmsg from "vmsg";
import './App.css';
import { sampleDeck } from './sampleDeck';

const recorder = new vmsg.Recorder({
  wasmURL: "https://unpkg.com/vmsg@0.3.0/vmsg.wasm"
});

function App() {
  const [userInput, setUserInput] = useState('');
  const [targetLang, setTargetLang] = useState('ko');
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  
  // Deck state
  const [currentDeck, setCurrentDeck] = useState(null);
  const [decks, setDecks] = useState({});
  const [deckFiles, setDeckFiles] = useState({});
  const [mode, setMode] = useState('list'); // 'list', 'edit', or 'review'
  const [maxNewCardsPerDay] = useState(25); // Default limit for new cards per day
  const [newCardsToday, setNewCardsToday] = useState(0);
  
  // Use refs to maintain audio elements
  const frontAudioRef = React.useRef(new Audio());
  const backAudioRef = React.useRef(new Audio());
  const blobUrlsRef = React.useRef({ front: null, back: null });
  const fileInputRef = React.useRef(null);

  const isDevelopment = process.env.NODE_ENV === 'development' || window.location.hostname === 'localhost';

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
      
      // Update decks state
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

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      importDeckFromFile(file);
    }
  };

  const addCardToDeck = async () => {
    if (!currentDeck || !card || !audioReady.front || !audioReady.back) {
      setError('Please select a deck and generate a card first');
      return;
    }

    try {
      // Get audio data as array buffers
      const frontResponse = await fetch(frontAudioRef.current.src);
      const backResponse = await fetch(backAudioRef.current.src);
      const frontAudioBuffer = await frontResponse.arrayBuffer();
      const backAudioBuffer = await backResponse.arrayBuffer();

      // Create compressed card data
      const cardData = {
        ...card,
        audioData: {
          front: Array.from(new Uint8Array(frontAudioBuffer)),
          back: Array.from(new Uint8Array(backAudioBuffer))
        },
        created: Date.now(),
        interval: 1, // Days between reviews
        easeFactor: 2.5, // Initial ease factor
        repetitions: 0, // Number of times reviewed
        lastReviewed: null,
        nextReview: new Date().toISOString().split('T')[0] // Review new cards today
      };

      setDecks(prev => ({
        ...prev,
        [currentDeck]: {
          ...prev[currentDeck],
          cards: [...prev[currentDeck].cards, cardData],
          lastModified: Date.now()
        }
      }));

      setError(null);
    } catch (err) {
      console.error('Error adding card to deck:', err);
      setError('Failed to add card to deck: ' + err.message);
    }
  };

  const loadCard = async (cardData) => {
    try {
      // Clean up existing audio URLs
      if (blobUrlsRef.current.front) URL.revokeObjectURL(blobUrlsRef.current.front);
      if (blobUrlsRef.current.back) URL.revokeObjectURL(blobUrlsRef.current.back);

      // Create new audio blobs
      const frontAudioBlob = new Blob([new Uint8Array(cardData.audioData.front)], { type: 'audio/mpeg' });
      const backAudioBlob = new Blob([new Uint8Array(cardData.audioData.back)], { type: 'audio/mpeg' });

      // Create and store new URLs
      const frontUrl = URL.createObjectURL(frontAudioBlob);
      const backUrl = URL.createObjectURL(backAudioBlob);
      blobUrlsRef.current = { front: frontUrl, back: backUrl };

      // Update audio elements
      frontAudioRef.current.src = frontUrl;
      backAudioRef.current.src = backUrl;

      // Update state
      const { audioData, created, ...cardWithoutAudio } = cardData;
      setCard(cardWithoutAudio);
      setAudioReady({ front: true, back: true });
    } catch (err) {
      console.error('Error loading card:', err);
      setError('Failed to load card: ' + err.message);
    }
  };

  const generateCard = async (e) => {
    e.preventDefault();
    console.log('Starting card generation...');
    setLoading(true);
    setError(null);
    setCard(null);
    setAudioReady({ front: false, back: false });
    setProgress({ text: false, front: false, back: false });

    // Clean up old blob URLs
    if (blobUrlsRef.current.front) {
      URL.revokeObjectURL(blobUrlsRef.current.front);
    }
    if (blobUrlsRef.current.back) {
      URL.revokeObjectURL(blobUrlsRef.current.back);
    }
    blobUrlsRef.current = { front: null, back: null };

    try {
      console.log('Sending request to server...');
      const response = await fetch('http://localhost:8000/api/generate_cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userInput,
          targetLang,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Server returned error:', errorData);
        throw new Error(errorData.error || 'Failed to generate card');
      }

      console.log('Starting to read stream...');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('Stream complete');
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            console.log('Processing data type:', data.type);
            
            if (data.type === 'card') {
              console.log('Setting card data:', data.data);
              setCard(data.data);
              setProgress(prev => ({ ...prev, text: true }));
            } else if (data.type === 'audio') {
              console.log(`Processing ${data.side} audio, size:`, data.data.length);
              
              const audioData = new Uint8Array(data.data);
              const blob = new Blob([audioData], { type: 'audio/mpeg' });
              const url = URL.createObjectURL(blob);
              
              if (data.side === 'front') {
                console.log('Setting front audio with URL:', url);
                frontAudioRef.current.src = url;
                blobUrlsRef.current.front = url;
                setAudioReady(prev => ({ ...prev, front: true }));
              } else {
                console.log('Setting back audio with URL:', url);
                backAudioRef.current.src = url;
                blobUrlsRef.current.back = url;
                setAudioReady(prev => ({ ...prev, back: true }));
              }

              setProgress(prev => ({
                ...prev,
                [data.side]: true
              }));

              console.log(`Audio element updated for ${data.side}:`, {
                side: data.side,
                url: url,
                audioSrc: data.side === 'front' ? frontAudioRef.current.src : backAudioRef.current.src
              });
            }
          } catch (e) {
            console.error('Error processing stream chunk:', e);
          }
        }
      }
    } catch (err) {
      console.error('Error in generateCard:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const playAudio = async (side) => {
    try {
      const audio = side === 'front' ? frontAudioRef.current : backAudioRef.current;
      console.log(`Playing ${side} audio:`, audio);
      
      if (!audio.src) {
        throw new Error('No audio available');
      }

      // Stop any currently playing audio
      frontAudioRef.current.pause();
      frontAudioRef.current.currentTime = 0;
      backAudioRef.current.pause();
      backAudioRef.current.currentTime = 0;

      // Play the selected audio
      await audio.play();
    } catch (err) {
      console.error('Error playing audio:', err);
      setError(`Failed to play audio: ${err.message}`);
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

  const handleDeckClick = (id) => {
    setCurrentDeck(id);
    setMode('review'); // Default to review mode when clicking deck name
  };

  const handleEditClick = (id, e) => {
    e.stopPropagation(); // Prevent deck click
    setCurrentDeck(id);
    setMode('edit');
  };

  const handleBackToList = () => {
    setCurrentDeck(null);
    setMode('list');
  };

  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [evaluationAudioRef] = useState(new Audio());

  // Add debug mode state
  const [debugMode] = useState(true); // Temporary: set to true for testing intervals
  
  // Modified getDueCards to respect new cards limit
  const getDueCards = (deckId) => {
    const deck = decks[deckId];
    if (!deck) return [];

    const now = new Date();
    
    // Separate new and review cards
    const newCards = deck.cards.filter(card => !card.lastReviewed);
    const reviewCards = deck.cards.filter(card => {
      if (!card.lastReviewed) return false;
      
      // If the card has a due timestamp (for cards due in minutes), check against that
      if (card.dueTimestamp) {
        return new Date(card.dueTimestamp) <= now;
      }
      
      // Check against next review timestamp
      if (!card.nextReview) return false;
      return new Date(card.nextReview) <= now;
    });

    // Limit new cards based on daily limit while preserving order
    const availableNewCards = newCards.slice(0, maxNewCardsPerDay - newCardsToday);
    
    // Sort review cards by due date/timestamp
    const sortedReviewCards = [...reviewCards].sort((a, b) => {
      const aTime = a.dueTimestamp ? new Date(a.dueTimestamp) : new Date(a.nextReview);
      const bTime = b.dueTimestamp ? new Date(b.dueTimestamp) : new Date(b.nextReview);
      return aTime - bTime;
    });
    
    // Return new cards first (in original order), then review cards (sorted by due time)
    return [...availableNewCards, ...sortedReviewCards];
  };

  // Update card scheduling
  const updateCardScheduling = (cardId, quality) => {
    console.log('Starting updateCardScheduling:', { cardId, quality });
    
    setDecks(prev => {
      const newDecks = { ...prev };
      const deck = newDecks[currentDeck];
      const cardIndex = deck.cards.findIndex(c => c.created === cardId);
      const card = deck.cards[cardIndex];
      
      console.log('Initial card state:', {
        interval: card.interval,
        repetitions: card.repetitions,
        easeFactor: card.easeFactor,
        lastReviewed: card.lastReviewed,
        nextReview: card.nextReview
      });

      // Initialize or fix any missing/invalid values
      if (typeof card.interval !== 'number' || isNaN(card.interval)) {
        card.interval = 1;
      }
      if (typeof card.repetitions !== 'number' || isNaN(card.repetitions)) {
        card.repetitions = 0;
      }
      if (typeof card.easeFactor !== 'number' || isNaN(card.easeFactor)) {
        card.easeFactor = 2.5; // 250%
      }

      // If this is a new card being reviewed for the first time
      if (!card.lastReviewed) {
        console.log('First review of card');
        setNewCardsToday(prev => prev + 1);
      }

      // Calculate late penalty/bonus
      const now = new Date();
      const dueDate = card.nextReview ? new Date(card.nextReview) : now;
      const daysLate = Math.max(0, (now - dueDate) / (1000 * 60 * 60 * 24));
      
      if (quality === 'correct') { // Correct response
        console.log('Correct response, updating intervals');
        // Clear any due timestamp since it passed review
        card.dueTimestamp = null;
        
        if (card.repetitions === 0) {
          card.interval = 1; // First interval
        } else if (card.repetitions === 1) {
          card.interval = 6; // Second interval
        } else {
          // Calculate new interval with late bonus
          const newInterval = Math.round(card.interval * card.easeFactor * (1 + 0.2 * daysLate));
          console.log('Calculating new interval:', {
            currentInterval: card.interval,
            easeFactor: card.easeFactor,
            daysLate,
            newInterval
          });
          // Cap at 10 years
          card.interval = Math.max(card.interval + 1, Math.min(newInterval, 365 * 10));
        }
        card.repetitions += 1;
        
        // Ensure minimum ease of 130%
        card.easeFactor = Math.max(1.3, card.easeFactor);

      } else { // Incorrect response
        console.log('Incorrect response, resetting interval');
        // Reset interval and reduce ease
        card.interval = 1;
        card.repetitions = 0;
        
        // Only decrease ease if not in learning phase (repetitions > 0)
        if (card.repetitions > 0) {
          card.easeFactor = Math.max(1.3, card.easeFactor - 0.2); // 20 percentage point decrease, minimum 130%
        }
        
        // Set to be reviewed in 10 minutes
        const dueTime = new Date();
        dueTime.setMinutes(dueTime.getMinutes() + 10);
        card.dueTimestamp = dueTime.toISOString();
        console.log('Set due timestamp to:', card.dueTimestamp);
      }

      try {
        // Calculate next review date
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + card.interval);
        card.nextReview = nextDate.toISOString();
        console.log('Set next review to:', card.nextReview);
      } catch (err) {
        console.error('Error calculating next review date:', err);
        // Fallback to tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        card.nextReview = tomorrow.toISOString();
        console.log('Used fallback date:', card.nextReview);
      }

      card.lastReviewed = new Date().toISOString();
      
      console.log('Final card state:', {
        interval: card.interval,
        repetitions: card.repetitions,
        easeFactor: card.easeFactor,
        lastReviewed: card.lastReviewed,
        nextReview: card.nextReview,
        dueTimestamp: card.dueTimestamp
      });

      deck.cards[cardIndex] = card;
      return newDecks;
    });
  };

  // Update due cards more frequently to catch cards becoming due
  useEffect(() => {
    if (currentDeck && mode === 'review') {
      const updateDueCards = () => {
        const due = getDueCards(currentDeck);
        setDueCards(due);
      };

      // Initial update
      updateDueCards();

      // Check for due cards every minute
      const interval = setInterval(updateDueCards, 60000);
      return () => clearInterval(interval);
    }
  }, [currentDeck, mode, decks]);

  // Modify handleEvaluationResult to include spaced repetition
  const handleEvaluationResult = (data) => {
    setEvaluationResult(data);
    console.log('Received evaluation result:', data);
    console.log('Audio data present:', !!data.audio);
    
    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';

    // Update card scheduling
    const currentCard = decks[currentDeck].cards[currentCardIndex];
    updateCardScheduling(currentCard.created, quality);
    
    // Play evaluation audio if available
    if (data.audio) {
      console.log('Audio data length:', data.audio.length);
      console.log('Audio data type:', typeof data.audio);
      const audioData = new Uint8Array(data.audio);
      console.log('Created Uint8Array with length:', audioData.length);
      const blob = new Blob([audioData], { type: 'audio/mpeg' });
      console.log('Created audio blob with size:', blob.size);
      const url = URL.createObjectURL(blob);
      console.log('Created audio URL:', url);
      evaluationAudioRef.src = url;
      evaluationAudioRef.play()
        .then(() => console.log('Started playing evaluation audio'))
        .catch(err => console.error('Error playing evaluation audio:', err));
      
      // Clean up the URL when audio ends
      evaluationAudioRef.onended = () => {
        console.log('Evaluation audio finished playing, cleaning up URL');
        URL.revokeObjectURL(url);
      };
    }
    
    if (data.result === 'quit') {
      setShowAnswer(true);
      setTimeout(moveToNextCard, 500); // Quick skip for quit commands
    } else if (data.result === 'correct') {
      setTimeout(moveToNextCard, 2000); // 2 second delay for correct answers
    } else {
      // Incorrect answer
      setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
          setShowAnswer(true);
          setTimeout(moveToNextCard, 2000);
        }
        return newAttempts;
      });
    }
  };

  const startRecording = async () => {
    setIsLoading(true);
    try {
      await recorder.initAudio();
      await recorder.initWorker();
      recorder.startRecording();
      setIsLoading(false);
      setIsRecording(true);
    } catch (e) {
      console.error('Error starting recording:', e);
      setError('Failed to start recording: ' + e.message);
      setIsLoading(false);
    }
  };

  const stopRecording = async () => {
    try {
      console.log('Stopping recording...');
      const audioBlob = await recorder.stopRecording();
      console.log('Got audio blob:', audioBlob);
      setIsRecording(false);

      if (audioBlob.size === 0) {
        console.error('No audio data recorded');
        setError('No audio data recorded. Please try again.');
        return;
      }

      const reader = new FileReader();
      reader.onloadend = async () => {
        console.log('User audio loaded');
        const base64Audio = reader.result.split(',')[1];
        console.log('User audio base64 length:', base64Audio?.length);
        const currentCard = decks[currentDeck].cards[currentCardIndex];
        console.log('Current card:', currentCard);
        
        try {
          // Get the expected audio data
          console.log('Fetching expected audio from:', backAudioRef.current.src);
          const backAudioResponse = await fetch(backAudioRef.current.src);
          const backAudioBlob = await backAudioResponse.blob();
          console.log('Got expected audio blob:', backAudioBlob);
          const backAudioReader = new FileReader();
          
          backAudioReader.onloadend = async () => {
            console.log('Expected audio loaded');
            const expectedAudioBase64 = backAudioReader.result.split(',')[1];
            console.log('Expected audio base64 length:', expectedAudioBase64?.length);
            
            console.log('Sending evaluation request with:', {
              audioBase64Length: base64Audio?.length,
              expectedTextLength: currentCard.backText?.length,
              sourceLang: currentCard.targetLang,
              expectedAudioBase64Length: expectedAudioBase64?.length
            });
            
            const response = await fetch('http://localhost:8000/api/evaluate_speech', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                audioBase64: base64Audio,
                expectedText: currentCard.backText,
                sourceLang: currentCard.targetLang,
                expectedAudioBase64: expectedAudioBase64,
                audioFormat: 'mp3'  // vmsg always produces MP3
              }),
            });

            if (!response.ok) {
              const errorData = await response.json();
              console.error('Server error response:', errorData);
              throw new Error('Failed to evaluate speech: ' + (errorData.error || 'Unknown error'));
            }

            const data = await response.json();
            handleEvaluationResult(data);
          };

          backAudioReader.readAsDataURL(backAudioBlob);
        } catch (err) {
          console.error('Error evaluating speech:', err);
          setError('Failed to evaluate speech: ' + err.message);
        }
      };

      reader.readAsDataURL(audioBlob);
    } catch (err) {
      console.error('Error stopping recording:', err);
      setError('Failed to stop recording: ' + err.message);
      setIsRecording(false);
    }
  };

  // Add state for due cards
  const [dueCards, setDueCards] = useState([]);

  // Reset attempts when moving to a new card
  useEffect(() => {
    setAttempts(0);
    setShowAnswer(false);
    setEvaluationResult(null);

    // Load audio for current card if in review mode
    if (mode === 'review' && dueCards.length > 0) {
      loadCard(dueCards[currentCardIndex]);
    }
  }, [currentCardIndex, mode, dueCards]);

  const moveToNextCard = () => {
    if (currentCardIndex < dueCards.length - 1) {
      setCurrentCardIndex(prev => prev + 1);
      setEvaluationResult(null);
      setAttempts(0);
      setShowAnswer(false);
    } else {
      // End of deck
      setCurrentCardIndex(0);
      handleBackToList();
    }
  };

  const loadSampleDeck = () => {
    const id = Date.now().toString();
    setDecks(prev => ({
      ...prev,
      [id]: sampleDeck
    }));
    setCurrentDeck(id);
  };

  return (
    <div className="App">
      <div className="container">
        <h1>Flashcard Generator</h1>
        
        {mode === 'list' && (
          <div className="deck-management">
            <h2>Decks</h2>
            <div className="deck-actions">
              <button onClick={createNewDeck} className="action-btn">
                📁 New Deck
              </button>
              <input
                type="file"
                accept=".bin"
                onChange={handleFileSelect}
                ref={fileInputRef}
                style={{ display: 'none' }}
              />
              <button onClick={() => fileInputRef.current.click()} className="action-btn">
                📥 Import Deck
              </button>
              <button onClick={loadSampleDeck} className="action-btn">
                🎲 Load Sample Deck
              </button>
            </div>
            
            <div className="deck-list">
              {Object.entries(decks).map(([id, deck]) => {
                const newCount = deck.cards.filter(card => !card.lastReviewed).length;
                const reviewCount = getDueCards(id).length - Math.min(newCount, maxNewCardsPerDay - newCardsToday);
                return (
                  <div 
                    key={id} 
                    className="deck-item"
                    onClick={() => handleDeckClick(id)}
                  >
                    <div className="deck-info">
                      <h3>{deck.name}</h3>
                      <small>
                        {deck.cards.length} cards (
                        {reviewCount} review{reviewCount !== 1 ? 's' : ''}, {' '}
                        {newCount} new)
                      </small>
                    </div>
                    <div className="deck-item-actions">
                      <button 
                        onClick={(e) => handleEditClick(id, e)}
                        className="icon-btn"
                        title="Edit Deck"
                      >
                        ✏️
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          exportDeckToFile(id, e);
                        }}
                        className="icon-btn"
                        title="Export Deck"
                      >
                        💾
                      </button>
                      <button 
                        onClick={(e) => deleteDeck(id, e)}
                        className="icon-btn"
                        title="Delete Deck"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {mode === 'edit' && currentDeck && (
          <>
            <div className="mode-header">
              <button onClick={handleBackToList} className="back-btn">← Back to Decks</button>
              <h2>Editing: {decks[currentDeck].name}</h2>
            </div>
            <form onSubmit={generateCard} className="card-form">
              <div className="form-group">
                <label htmlFor="userInput">Enter text to translate:</label>
                <textarea
                  id="userInput"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  required
                  placeholder="Enter text to translate..."
                />
              </div>

              <div className="form-group">
                <label htmlFor="targetLang">Target Language:</label>
                <select
                  id="targetLang"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="it">Italian</option>
                  <option value="pt">Portuguese</option>
                  <option value="ru">Russian</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                  <option value="zh">Chinese</option>
                  <option value="en">English</option>
                </select>
              </div>

              <button type="submit" disabled={loading}>
                {loading ? 'Generating...' : 'Generate Flashcard'}
              </button>
            </form>

            <div className="file-actions">
              <button 
                onClick={addCardToDeck}
                disabled={!card || !audioReady.front || !audioReady.back}
                className="action-btn"
              >
                ➕ Add to Deck
              </button>
            </div>

            {decks[currentDeck]?.cards.length > 0 && (
              <div className="deck-cards">
                <h3>Cards in Deck</h3>
                <div className="card-list">
                  {decks[currentDeck].cards.map((cardData, index) => (
                    <div 
                      key={cardData.created} 
                      className="card-item"
                      onClick={() => loadCard(cardData)}
                    >
                      <span>Card {index + 1}</span>
                      <small>{cardData.frontText}</small>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'review' && currentDeck && (
          <>
            <div className="mode-header">
              <button onClick={handleBackToList} className="back-btn">← Back to Decks</button>
              <h2>Reviewing: {decks[currentDeck].name}</h2>
              <div className="review-stats">
                <small>
                  New cards today: {newCardsToday}/{maxNewCardsPerDay}
                </small>
              </div>
            </div>
            <div className="review-mode">
              {dueCards.length > 0 ? (
                <div className="review-card">
                  <div className="card-progress">
                    Card {currentCardIndex + 1} of {dueCards.length} due
                    {!dueCards[currentCardIndex].lastReviewed && ' (New)'}
                  </div>
                  
                  <div className="flashcard">
                    <div className="card-side">
                      <h3>Front</h3>
                      <p>{dueCards[currentCardIndex].frontText}</p>
                      <button 
                        onClick={() => playAudio('front')}
                        className="play-audio-btn"
                      >
                        🔊 Play Audio
                      </button>
                    </div>
                    {showAnswer && (
                      <div className="card-side">
                        <h3>Answer</h3>
                        <p>{dueCards[currentCardIndex].backText}</p>
                        <button 
                          onClick={() => playAudio('back')}
                          className="play-audio-btn"
                        >
                          🔊 Play Audio
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="review-controls">
                    <div className="attempts-counter">
                      Attempts: {attempts}/3
                    </div>
                    
                    <div className="test-buttons">
                      <button
                        onClick={() => handleEvaluationResult({ result: 'correct', message: 'Test: Marked as correct' })}
                        className="test-btn correct"
                        disabled={showAnswer}
                      >
                        ✅ CORRECT
                      </button>
                      <button
                        onClick={() => handleEvaluationResult({ result: 'incorrect', message: 'Test: Marked as incorrect' })}
                        className="test-btn incorrect"
                        disabled={showAnswer}
                      >
                        ❌ INCORRECT
                      </button>
                    </div>

                    <button
                      onClick={isRecording ? stopRecording : startRecording}
                      className={`record-btn ${isRecording ? 'recording' : ''}`}
                      disabled={showAnswer || isLoading}
                    >
                      {isLoading ? '⏳ Initializing...' : isRecording ? '⬛ Stop Recording' : '⚫ Start Recording'}
                    </button>
                    
                    {evaluationResult && (
                      <div className={`evaluation-result ${evaluationResult.result}`}>
                        <div className="result-icon">
                          {evaluationResult.result === 'correct' && '✅ Correct!'}
                          {evaluationResult.result === 'incorrect' && '❌ Try again'}
                          {evaluationResult.result === 'quit' && '⏭️ Skipped'}
                        </div>
                        <div className="result-message">
                          {evaluationResult.message}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="review-complete">
                  <h3>Review Complete! 🎉</h3>
                  <p>No more cards due for review at this time.</p>
                  <button onClick={handleBackToList} className="back-btn">
                    Return to Decks
                  </button>
                </div>
              )}
            </div>

            {/* Timeline visualization */}
            <div className="timeline-container">
              <div className="timeline">
                <div className="timeline-line"></div>
                <div 
                  className="timeline-now"
                  style={{ left: '0%' }}
                ></div>
                {(() => {
                  const now = new Date();
                  
                  // Calculate max interval in the deck
                  const intervals = decks[currentDeck].cards
                    .filter(card => card.nextReview || card.lastReviewed)
                    .map(card => {
                      const reviewDate = new Date(card.nextReview || card.lastReviewed);
                      return Math.abs((reviewDate - now) / (1000 * 60 * 60)); // hours
                    });
                  const maxHoursDiff = Math.max(...intervals, 24); // minimum 24h for scale
                  const maxLogValue = Math.log2(maxHoursDiff + 1);
                  
                  console.log('Timeline scale:', {
                    maxHoursDiff,
                    maxLogValue,
                    intervals: intervals.sort((a, b) => a - b)
                  });

                  return decks[currentDeck].cards.map((card) => {
                    // Skip cards without a next review date
                    if (!card.nextReview && !card.lastReviewed) return null;

                    // Calculate time difference in hours
                    const reviewDate = new Date(card.nextReview || card.lastReviewed);
                    const hoursDiff = (reviewDate - now) / (1000 * 60 * 60);
                    
                    // Use logarithmic scale for position
                    // Add 1 to handle negative values (past due cards)
                    const logPosition = Math.log2(Math.abs(hoursDiff) + 1);
                    
                    // Calculate position percentage
                    // Past due cards: 0-10%
                    // Future cards: 10-100%
                    let position;
                    if (hoursDiff < 0) {
                      // Past due cards in reverse log scale in 0-10% range
                      position = 10 - (logPosition / maxLogValue) * 10;
                    } else {
                      // Future cards in log scale in 10-100% range
                      position = 10 + (logPosition / maxLogValue) * 90;
                    }
                    
                    // Clamp position between 0 and 100
                    const clampedPosition = Math.max(0, Math.min(100, position));

                    return (
                      <div
                        key={card.created}
                        className={`timeline-card ${dueCards.length > 0 && card.created === dueCards[currentCardIndex]?.created ? 'current' : ''}`}
                        style={{ left: `${clampedPosition}%` }}
                        onClick={() => {
                          const cardIdx = dueCards.findIndex(c => c.created === card.created);
                          if (cardIdx !== -1) setCurrentCardIndex(cardIdx);
                        }}
                      >
                        <div className="front-text">{card.frontText}</div>
                        <div className="stats">
                          Ease: {card.easeFactor?.toFixed(2) || 2.5}<br />
                          Interval: {card.interval || 0} days<br />
                          Next: {new Date(card.nextReview || card.lastReviewed).toLocaleDateString()}<br />
                          {hoursDiff < 0 ? `${Math.abs(Math.round(hoursDiff))}h overdue` : 
                           hoursDiff < 24 ? `in ${Math.round(hoursDiff)}h` :
                           `in ${Math.round(hoursDiff / 24)}d`}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="error-message">
            Error: {error}
          </div>
        )}

        {loading && (
          <div className="progress">
            <p>Generating: {' '}
              {progress.text ? '✓ Text ' : '⋯ Text '}
              {progress.front ? '✓ Front Audio ' : '⋯ Front Audio '}
              {progress.back ? '✓ Back Audio' : '⋯ Back Audio'}
            </p>
          </div>
        )}

        {card && mode === 'edit' && (
          <div className="card-result">
            <div className="flashcard">
              <div className="card-side">
                <h3>Front</h3>
                <p>{card.frontText}</p>
                <small>Language: {card.sourceLang}</small>
                <button 
                  onClick={() => playAudio('front')}
                  className="play-audio-btn"
                  disabled={!audioReady.front}
                >
                  🔊 Play Audio
                </button>
              </div>
              <div className="card-side">
                <h3>Back</h3>
                <p>{card.backText}</p>
                <small>Language: {card.targetLang}</small>
                <button 
                  onClick={() => playAudio('back')}
                  className="play-audio-btn"
                  disabled={!audioReady.back}
                >
                  🔊 Play Audio
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
