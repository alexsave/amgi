import React from 'react';
import { useState } from 'react';
import './App.css';

function App() {
  const [userInput, setUserInput] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  
  // Use refs to maintain audio elements
  const frontAudioRef = React.useRef(new Audio());
  const backAudioRef = React.useRef(new Audio());
  const blobUrlsRef = React.useRef({ front: null, back: null });

  const isDevelopment = process.env.NODE_ENV === 'development' || window.location.hostname === 'localhost';

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
          sourceLang,
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
            <label htmlFor="sourceLang">Source Language:</label>
            <select
              id="sourceLang"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ru">Russian</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </div>

          <button type="submit" disabled={loading}>
            {loading ? 'Generating...' : 'Generate Flashcard'}
          </button>
        </form>

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
