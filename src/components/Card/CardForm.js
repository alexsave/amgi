import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAudio } from '../../hooks/useAudio';
import { useCardGeneration } from '../../hooks/useCardGeneration';
import { useDecks } from '../../contexts/DeckContext';
import { getLanguageDisplay } from '../../constants/languages';
import './CardForm.css';

const CardForm = () => {
  const { id: deckId } = useParams();
  const [user_input, setUserInput] = useState('');
  const [error, setError] = useState(null);
  const { playAudio } = useAudio();
  const { generateCard, generatedCard, isGenerating } = useCardGeneration();
  const { decks, addCardToDeck } = useDecks();

  const currentDeck = decks[deckId];
  
  const [front_text, setfront_text] = useState('');
  const [back_text, setback_text] = useState('');
  const [front_audio_url, setFrontAudioUrl] = useState(null);
  const [back_audio_url, setBackAudioUrl] = useState(null);

  useEffect(() => {
    console.log('CardForm: useEffect triggered with generatedCard:', generatedCard);
    if (generatedCard) {
      setfront_text(generatedCard.front_text);
      setback_text(generatedCard.back_text);
      setFrontAudioUrl(generatedCard.front_audio_path);
      setBackAudioUrl(generatedCard.back_audio_path);
    }
  }, [generatedCard]);

  // If the deck doesn't exist yet, show a loading state
  if (!currentDeck) {
    return <div className="loading">Loading deck information...</div>;
  }

  const { known_language = 'en', learning_language = 'ko' } = currentDeck;

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('CardForm: handleSubmit called with user_input:', user_input);
    if (!user_input.trim()) {
      setError('Please enter some text');
      return;
    }
    setError(null);

    try {
      console.log('CardForm: Calling generateCard with:', {
        user_input,
        known_language,
        learning_language,
      });
      await generateCard(
        user_input, 
        known_language, 
        learning_language
      );
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
      front_audio_url,
      back_audio_url,
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
        front_lang: generatedCard.front_lang || known_language,
        back_lang: generatedCard.back_lang || learning_language,
        front_audio_path: generatedCard.front_audio_path,
        back_audio_path: generatedCard.back_audio_path
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
        <div className="form-info">
          <p className="language-info">
            Creating cards for: {getLanguageDisplay(known_language).flag} {getLanguageDisplay(known_language).name} → {getLanguageDisplay(learning_language).flag} {getLanguageDisplay(learning_language).name}
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="user_input">Text to Translate</label>
          <textarea
            id="user_input"
            value={user_input}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={`Enter text in ${getLanguageDisplay(known_language).name} or ${getLanguageDisplay(learning_language).name}`}
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
              {generatedCard.front_audio_path && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio(generatedCard.front_audio_path)}
                >
                  🔊 Play Audio
                </button>
              )}
            </div>
            <div className="card-side">
              <h3>Back</h3>
              <p>{generatedCard.back_text}</p>
              {generatedCard.back_audio_path && (
                <button
                  className="play-audio-btn"
                  onClick={() => playAudio(generatedCard.back_audio_path)}
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