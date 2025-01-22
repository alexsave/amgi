import React from 'react';
import { useState } from 'react';
import './App.css';

function App() {
  const [userInput, setUserInput] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const generateCard = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setCard(null);

    try {
      const response = await fetch('http://localhost:8000/api/generate_cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          //'Access-Control-Allow-Origin': '*',
        },
        //credentials: 'include',
        body: JSON.stringify({
          userInput,
          sourceLang,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate card');
      }

      const data = await response.json();
      setCard(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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

        {card && (
          <div className="card-result">
            <div className="flashcard">
              <div className="card-side">
                <h3>Front</h3>
                <p>{card.frontText}</p>
                <small>Language: {card.sourceLang}</small>
                <button 
                  onClick={() => new Audio(card.frontAudioUrl).play()}
                  className="play-audio-btn"
                >
                  🔊 Play Audio
                </button>
              </div>
              <div className="card-side">
                <h3>Back</h3>
                <p>{card.backText}</p>
                <small>Language: {card.targetLang}</small>
                <button 
                  onClick={() => new Audio(card.backAudioUrl).play()}
                  className="play-audio-btn"
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
