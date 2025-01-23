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

const CardForm = () => {
  const [userInput, setUserInput] = useState('');
  const [targetLang, setTargetLang] = useState('ko');
  const [error, setError] = useState(null);

  const audio = useAudio();
  const cardGeneration = useCardGeneration();
  const deckManagement = useDeckManagement();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await cardGeneration.generateCard(
        userInput,
        targetLang,
        audio.blobUrlsRef,
        audio.frontAudioRef,
        audio.backAudioRef
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddToDeck = async () => {
    if (!cardGeneration.card || !cardGeneration.audioReady.front || !cardGeneration.audioReady.back) {
      setError('Please generate a card first');
      return;
    }

    try {
      // Get audio data as array buffers
      const frontResponse = await fetch(audio.frontAudioRef.current.src);
      const backResponse = await fetch(audio.backAudioRef.current.src);
      const frontAudioBuffer = await frontResponse.arrayBuffer();
      const backAudioBuffer = await backResponse.arrayBuffer();

      // Create card data
      const cardData = {
        ...cardGeneration.card,
        audioData: {
          front: Array.from(new Uint8Array(frontAudioBuffer)),
          back: Array.from(new Uint8Array(backAudioBuffer))
        }
      };

      await deckManagement.addCardToDeck(cardData);
      setUserInput('');
      cardGeneration.setCard(null);
      cardGeneration.setAudioReady({ front: false, back: false });
      audio.cleanupAudioUrls();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="card-form-container">
      <form onSubmit={handleSubmit} className="card-form">
        <div className="form-group">
          <label htmlFor="userInput">Source Text:</label>
          <textarea
            id="userInput"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder="Enter text to translate..."
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="targetLang">Target Language:</label>
          <select
            id="targetLang"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
          >
            {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
              <option key={code} value={code}>
                <span className="language-option">
                  {flag} {name}
                </span>
              </option>
            ))}
          </select>
        </div>

        <button type="submit" disabled={cardGeneration.loading || !userInput}>
          Generate Card
        </button>

        {error && <div className="error">{error}</div>}

        {cardGeneration.loading && (
          <div className="progress">
            {!cardGeneration.progress.text && <p>Generating translation...</p>}
            {cardGeneration.progress.text && !cardGeneration.progress.front && <p>Generating front audio...</p>}
            {cardGeneration.progress.front && !cardGeneration.progress.back && <p>Generating back audio...</p>}
          </div>
        )}

        {cardGeneration.card && (
          <div className="card-preview">
            <h3>Card Preview:</h3>
            <div className="flashcard">
              <div className="card-side">
                <h3>Front</h3>
                <p>{cardGeneration.card.frontText}</p>
                <small>{cardGeneration.card.frontPronunciation}</small>
                {cardGeneration.audioReady.front && (
                  <button
                    type="button"
                    className="play-audio-btn"
                    onClick={() => audio.playAudio('front')}
                  >
                    Play Audio
                  </button>
                )}
              </div>
              <div className="card-side">
                <h3>Back</h3>
                <p>{cardGeneration.card.backText}</p>
                <small>{cardGeneration.card.backPronunciation}</small>
                {cardGeneration.audioReady.back && (
                  <button
                    type="button"
                    className="play-audio-btn"
                    onClick={() => audio.playAudio('back')}
                  >
                    Play Audio
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              className="add-to-deck-btn"
              onClick={handleAddToDeck}
              disabled={!cardGeneration.audioReady.front || !cardGeneration.audioReady.back}
            >
              Add to Deck
            </button>
          </div>
        )}
      </form>
    </div>
  );
};

export default CardForm; 