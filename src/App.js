import React from 'react';
import { useState, useEffect } from 'react';
import msgpack from 'msgpack-lite';
import vmsg from "vmsg";
import './App.css';

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
  
  // Use refs to maintain audio elements
  const frontAudioRef = React.useRef(new Audio());
  const backAudioRef = React.useRef(new Audio());
  const blobUrlsRef = React.useRef({ front: null, back: null });
  const fileInputRef = React.useRef(null);

  const isDevelopment = process.env.NODE_ENV === 'development' || window.location.hostname === 'localhost';

  // Load decks from localStorage on mount
  useEffect(() => {
    const savedDecks = localStorage.getItem('decks');
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
  }, []);

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
        created: Date.now()
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

  // Reset attempts when moving to a new card
  useEffect(() => {
    setAttempts(0);
    setShowAnswer(false);
    setEvaluationResult(null);

    // Load audio for current card if in review mode
    if (mode === 'review' && currentDeck && decks[currentDeck]?.cards[currentCardIndex]) {
      loadCard(decks[currentDeck].cards[currentCardIndex]);
    }
  }, [currentCardIndex, mode, currentDeck]);

  const moveToNextCard = () => {
    if (currentCardIndex < decks[currentDeck].cards.length - 1) {
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

  const handleEvaluationResult = (data) => {
    setEvaluationResult(data);
    
    if (data.isCommand || data.result === 'quit') {
      setShowAnswer(true);
      setTimeout(moveToNextCard, 2000);
    } else if (data.result === 'correct') {
      setTimeout(moveToNextCard, 1500);
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
            </div>
            
            <div className="deck-list">
              {Object.entries(decks).map(([id, deck]) => (
                <div 
                  key={id} 
                  className="deck-item"
                  onClick={() => handleDeckClick(id)}
                >
                  <div className="deck-info">
                    <h3>{deck.name}</h3>
                    <small>{deck.cards.length} cards</small>
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
              ))}
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
            </div>
            <div className="review-mode">
              {decks[currentDeck].cards.length > 0 ? (
                <div className="review-card">
                  <div className="card-progress">
                    Card {currentCardIndex + 1} of {decks[currentDeck].cards.length}
                  </div>
                  
                  <div className="flashcard">
                    <div className="card-side">
                      <h3>Front</h3>
                      <p>{decks[currentDeck].cards[currentCardIndex].frontText}</p>
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
                        <p>{decks[currentDeck].cards[currentCardIndex].backText}</p>
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
                <p>No cards in this deck yet. Add some cards in edit mode first.</p>
              )}
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
