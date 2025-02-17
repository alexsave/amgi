import React, { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAudio } from '../../hooks/useAudio';
import { useCardGeneration } from '../../hooks/useCardGeneration';
import { useDecks } from '../../contexts/DeckContext';
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
  const { id: deckId } = useParams();
  const [userInput, setUserInput] = useState('');
  const [targetLang, setTargetLang] = useState('ko');
  const [error, setError] = useState(null);
  const { playAudio } = useAudio();
  const { generateCard, generatedCard, audioUrls, isGenerating } = useCardGeneration();
  const { addCardToDeck } = useDecks();
  //const { addCardToDeck } = useDeckManagement();

  const blobUrlsRef = useRef({ front: null, back: null });
  const frontAudioRef = useRef(new Audio());
  const backAudioRef = useRef(new Audio());

  const [front_text, setfront_text] = useState('');
  const [back_text, setback_text] = useState('');
  const [frontAudioUrl, setFrontAudioUrl] = useState(null);
  const [backAudioUrl, setBackAudioUrl] = useState(null);

  useEffect(() => {
    console.log('CardForm: useEffect triggered with generatedCard:', generatedCard);
    if (generatedCard) {
      setfront_text(generatedCard.front_text);
      setback_text(generatedCard.back_text);
    }
  }, [generatedCard]);

  useEffect(() => {
    console.log('CardForm: useEffect triggered with audioUrls:', audioUrls);
    if (generatedCard) {
      console.log('CardForm: Setting front text to:', generatedCard.front_text);
      console.log('CardForm: Setting back text to:', generatedCard.back_text);
      console.log('CardForm: Setting front audio URL to:', audioUrls.front);
      console.log('CardForm: Setting back audio URL to:', audioUrls.back);
      setfront_text(generatedCard.front_text);
      setback_text(generatedCard.back_text);
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
  }, [audioUrls]);

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
      front_text,
      back_text,
      frontAudioUrl,
      backAudioUrl,
      deckId
    });
    if (!front_text || !back_text) {
      setError('No card data to add');
      return;
    }
    try {
      const card = {
        front_text,
        back_text,
        frontLang: generatedCard.frontLang,
        backLang: generatedCard.backLang,
        frontAudioId: generatedCard.frontAudioId,
        backAudioId: generatedCard.backAudioId
      };
      console.log('CardForm: Adding card to deck:', { deckId, card });
      await addCardToDeck(deckId, card);
      console.log('CardForm: Successfully added card to deck');
      setError(null);
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
              <p>{generatedCard.front_text}</p>
              {audioUrls.front && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio('front', generatedCard.frontAudioId)}
                >
                  🔊 Play Audio
                </button>
              )}
            </div>
            <div className="card-side">
              <h3>Back</h3>
              <p>{generatedCard.back_text}</p>
              {audioUrls.back && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio('back', generatedCard.backAudioId)}
                >
                  🔊 Play Audio
                </button>
              )}
            </div>
          </div>

          <button 
            onClick={handleAddToDeck} 
            className="add-to-deck-btn"
          >
            Add to Deck
          </button>
        </div>
      )}
    </div>
  );
};

export default CardForm; 