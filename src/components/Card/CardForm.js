import React, { useState, useRef, useEffect } from 'react';
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

  const blobUrlsRef = useRef({ front: null, back: null });
  const frontAudioRef = useRef(new Audio());
  const backAudioRef = useRef(new Audio());

  const [frontText, setFrontText] = useState('');
  const [backText, setBackText] = useState('');
  const [frontAudioUrl, setFrontAudioUrl] = useState(null);
  const [backAudioUrl, setBackAudioUrl] = useState(null);

  useEffect(() => {
    console.log('CardForm: useEffect triggered with generatedCard:', generatedCard);
    console.log('CardForm: useEffect triggered with audioUrls:', audioUrls);
    if (generatedCard) {
      console.log('CardForm: Setting front text to:', generatedCard.frontText);
      console.log('CardForm: Setting back text to:', generatedCard.backText);
      console.log('CardForm: Setting front audio URL to:', audioUrls.front);
      console.log('CardForm: Setting back audio URL to:', audioUrls.back);
      setFrontText(generatedCard.frontText);
      setBackText(generatedCard.backText);
      setFrontAudioUrl(audioUrls.front);
      setBackAudioUrl(audioUrls.back);

      // Set audio sources
      if (audioUrls.front) {
        frontAudioRef.current.src = audioUrls.front;
        blobUrlsRef.current.front = audioUrls.front;
      }
      if (audioUrls.back) {
        backAudioRef.current.src = audioUrls.back;
        blobUrlsRef.current.back = audioUrls.back;
      }
    }
  }, [generatedCard, audioUrls]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('CardForm: handleSubmit called with userInput:', userInput);
    if (!userInput.trim()) {
      setError('Please enter some text');
      return;
    }
    setError(null);

    try {
      console.log('CardForm: Calling generateCard with:', {
        userInput,
        targetLang,
        blobUrlsRef: blobUrlsRef.current,
        frontAudioRef: frontAudioRef.current,
        backAudioRef: backAudioRef.current
      });
      await generateCard(userInput, targetLang, blobUrlsRef, frontAudioRef, backAudioRef);
      console.log('CardForm: generateCard completed successfully');
      setUserInput(''); // Clear input after successful generation
    } catch (err) {
      console.error('CardForm: Error in handleSubmit:', err);
      setError(err.message);
    }
  };

  const handleAddToDeck = async () => {
    console.log('CardForm: handleAddToDeck called with:', {
      frontText,
      backText,
      frontAudioUrl,
      backAudioUrl
    });
    if (!frontText || !backText) return;
    try {
      const card = {
        frontText,
        backText,
        audioUrls: {
          front: frontAudioUrl,
          back: backAudioUrl
        }
      };
      console.log('CardForm: Adding card to deck:', card);
      await addCardToDeck(card);
      console.log('CardForm: Successfully added card to deck');
    } catch (err) {
      console.error('CardForm: Error in handleAddToDeck:', err);
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

          <button onClick={handleAddToDeck} className="add-to-deck-btn">
            Add to Deck
          </button>
        </div>
      )}
    </div>
  );
};

export default CardForm; 