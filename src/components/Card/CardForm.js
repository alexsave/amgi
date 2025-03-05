import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDecks } from '../../contexts/DeckContext';
import { useCardGenerationContext } from '../../contexts/CardGenerationContext';
import { getLanguageDisplay } from '../../constants/languages';
import './CardForm.css';

const CardForm = ({ onCardGenerated, onGenerationStart }) => {
  const { id: deckId } = useParams();
  const { decks } = useDecks();
  const { 
    user_input, 
    setUserInput, 
    isGenerating,
    error: contextError,
    setError: setContextError, 
    generateCard 
  } = useCardGenerationContext();
  const [error, setError] = useState('');

  const currentDeck = decks[deckId];

  if (!currentDeck) {
    return <div className="loading">Loading deck information...</div>;
  }

  const { known_language = 'en', learning_language = 'ko' } = currentDeck;

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('CardForm: handleSubmit called with user_input:', user_input);
    if (!user_input.trim()) {
      setError('Please enter some text');
      setContextError('Please enter some text');
      return;
    }
    setError('');
    setContextError(null);

    // Call onGenerationStart before starting generation
    if (onGenerationStart) {
      onGenerationStart();
    }

    try {
      const result = await generateCard(
        user_input,
        known_language,
        learning_language
      );
  
      if (result && onCardGenerated) {
        console.log('CardForm: Card generated successfully, calling onCardGenerated');
        onCardGenerated(result);
      } else if (!result) {
        console.warn('CardForm: No result returned from generateCard');
      }
    } catch (err) {
      console.error('CardForm: Error generating card:', err);
      setError(err.message);
    }
  };

  // Use either local error or context error
  const displayError = error || contextError;

  return (
    <div className="card-form-container">
      <form onSubmit={handleSubmit} className="card-form">
        <div className="form-group">
          <label htmlFor="user_input">Text to Translate</label>
          <textarea
            id="user_input"
            value={user_input}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={`Enter text in ${getLanguageDisplay(known_language).name} or ${getLanguageDisplay(learning_language).name}`}
            rows={2}
          />
        </div>

        {displayError && <div className="error-message">{displayError}</div>}

        <button type="submit" disabled={isGenerating} className="generate-button">
          {isGenerating ? 'Generating...' : 'Generate Card'}
        </button>
      </form>
    </div>
  );
};

export default CardForm; 