import React from 'react';
import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [userInput, setUserInput] = useState('');
  const [targetLang, setTargetLang] = useState('ko');
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  const [lastLoadedFile, setLastLoadedFile] = useState(null);
  
  // Use refs to maintain audio elements
  const frontAudioRef = React.useRef(new Audio());
  const backAudioRef = React.useRef(new Audio());
  const blobUrlsRef = React.useRef({ front: null, back: null });
  const fileInputRef = React.useRef(null);

  const isDevelopment = process.env.NODE_ENV === 'development' || window.location.hostname === 'localhost';

  // Load last file path from localStorage on mount
  useEffect(() => {
    const savedFilePath = localStorage.getItem('lastLoadedFile');
    if (savedFilePath) {
      setLastLoadedFile(savedFilePath);
      loadCardFromFile(savedFilePath);
    }
  }, []);

  const saveCardToFile = async () => {
    if (!card || !audioReady.front || !audioReady.back) {
      setError('No card or audio data available to save');
      return;
    }

    try {
      // Get audio data as array buffers
      const frontResponse = await fetch(frontAudioRef.current.src);
      const backResponse = await fetch(backAudioRef.current.src);
      const frontAudioBuffer = await frontResponse.arrayBuffer();
      const backAudioBuffer = await backResponse.arrayBuffer();

      // Create card data object
      const cardData = {
        ...card,
        audioData: {
          front: Array.from(new Uint8Array(frontAudioBuffer)),
          back: Array.from(new Uint8Array(backAudioBuffer))
        }
      };

      // Create blob and download
      const blob = new Blob([JSON.stringify(cardData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flashcard-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error saving card:', err);
      setError('Failed to save card: ' + err.message);
    }
  };

  const loadCardFromFile = async (filePath) => {
    try {
      const file = filePath instanceof File ? filePath : await fetch(filePath).then(r => r.blob());
      const text = await file.text();
      const cardData = JSON.parse(text);

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
      const { audioData, ...cardWithoutAudio } = cardData;
      setCard(cardWithoutAudio);
      setAudioReady({ front: true, back: true });
      
      // Save file path to localStorage if it's a File object
      if (filePath instanceof File) {
        const savedPath = URL.createObjectURL(filePath);
        localStorage.setItem('lastLoadedFile', savedPath);
        setLastLoadedFile(savedPath);
      }
    } catch (err) {
      console.error('Error loading card:', err);
      setError('Failed to load card: ' + err.message);
    }
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      loadCardFromFile(file);
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

  // Clean up blob URLs when component unmounts
  React.useEffect(() => {
    return () => {
      if (blobUrlsRef.current.front) {
        URL.revokeObjectURL(blobUrlsRef.current.front);
      }
      if (blobUrlsRef.current.back) {
        URL.revokeObjectURL(blobUrlsRef.current.back);
      }
    };
  }, []);

  return (
    <div className="App">
      <div className="container">
        <h1>Flashcard Generator</h1>
        
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
            onClick={saveCardToFile} 
            disabled={!card || !audioReady.front || !audioReady.back}
            className="action-btn"
          >
            💾 Save Card
          </button>
          <input
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            ref={fileInputRef}
            style={{ display: 'none' }}
          />
          <button 
            onClick={() => fileInputRef.current.click()}
            className="action-btn"
          >
            📂 Load Card
          </button>
        </div>

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

        {card && (
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
