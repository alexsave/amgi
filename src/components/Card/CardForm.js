import React, { useState } from 'react';
import { useAudio } from '../../hooks/useAudio';
import { useCardGeneration } from '../../hooks/useCardGeneration';
import { useDeckManagement } from '../../hooks/useDeckManagement';
import './CardForm.css';

const LANGUAGES = {
  ko: { name: 'Korean', flag: '🇰🇷' },
  ja: { name: 'Japanese', flag: '🇯🇵' },
  zh: { name: 'Chinese', flag: '🇨🇳' },
  es: { name: 'Spanish', flag: '🇪🇸' },
  de: { name: 'German', flag: '🇩🇪' },
  it: { name: 'Italian', flag: '🇮🇹' },
};

const CardForm = ({ directMode = false }) => {
  const [userInput, setUserInput] = useState('');
  const [targetLang, setTargetLang] = useState('ko');
  const [error, setError] = useState(null);
  const { playAudio } = useAudio();
  const { generateCard, generatedCard, audioUrls, isGenerating } = useCardGeneration();
  const { addCardToDeck } = useDeckManagement();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!userInput.trim()) {
      setError('Please enter some text');
      return;
    }
    setError(null);
    
    try {
      await generateCard(userInput, targetLang);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddToDeck = async () => {
    if (!generatedCard) return;
    try {
      await addCardToDeck(generatedCard);
      setUserInput('');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="card-form-container">
      <form onSubmit={handleSubmit} className="card-form">
        <div className="form-group">
          <label htmlFor="targetLang">Target Language</label>
          <select
            id="targetLang"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
          >
            {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
              <option key={code} value={code}>
                {flag} {name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="userInput">Text to Translate</label>
          <textarea
            id="userInput"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={`Enter text in English or ${LANGUAGES[targetLang].name}`}
            rows={4}
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={isGenerating}>
          {isGenerating ? 'Generating...' : 'Generate Card'}
        </button>
      </form>

      {generatedCard && (
        <div className="card-result">
          <div className="flashcard">
            <div className="card-side">
              <h3>Front</h3>
              <p>{generatedCard.frontText}</p>
              {audioUrls.front && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio(audioUrls.front)}
                >
                  🔊 Play Audio
                </button>
              )}
            </div>
            <div className="card-side">
              <h3>Back</h3>
              <p>{generatedCard.backText}</p>
              {audioUrls.back && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio(audioUrls.back)}
                >
                  🔊 Play Audio
                </button>
              )}
            </div>
          </div>
          
          {!directMode && (
            <button onClick={handleAddToDeck} className="add-to-deck-btn">
              Add to Deck
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default CardForm; 