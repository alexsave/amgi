import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useAudio } from '../../hooks/useAudio';
import { useDecks } from '../../contexts/DeckContext';
import { useCardGenerationContext } from '../../contexts/CardGenerationContext';
import { getLanguageDisplay } from '../../constants/languages';
import './CardModal.css';

const CardModal = ({ isOpen, onClose }) => {
  const { id: deckId } = useParams();
  const { playAudio } = useAudio();
  const { decks, addCardToDeck, currentDeckId } = useDecks();
  const { generatedCard, clearGeneratedCard, clearInput } = useCardGenerationContext();
  const modalRef = useRef(null);

  const [error, setError] = useState('');

  const currentDeck = decks[deckId];

  // Close on escape key
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => document.removeEventListener('keydown', handleEscKey);
  }, [isOpen, onClose]);

  // Handle clicking outside modal
  const handleBackdropClick = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      onClose();
    }
  };

  // Reset error when modal opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
    }
  }, [isOpen]);

  // Handle modal close cleanly
  const handleCloseModal = () => {
    setError(null);
    onClose();
  };

  if (!isOpen || !generatedCard) return null;

  // If deck doesn't exist, don't show the modal
  if (!currentDeck) return null;

  const { known_language = 'en', learning_language = 'ko' } = currentDeck;

  const handleAddToDeck = async () => {
    if (!generatedCard) {
      setError('No card data to add');
      return;
    }
    try {
      // Create the first card (original direction)
      const firstCard = {
        front_text: generatedCard.front_text,
        back_text: generatedCard.back_text,
        front_lang: generatedCard.front_lang || known_language,
        back_lang: generatedCard.back_lang || learning_language,
        front_audio_path: generatedCard.front_audio_path,
        back_audio_path: generatedCard.back_audio_path
      };

      // Create the second card (reversed direction)
      const secondCard = {
        front_text: generatedCard.back_text,
        back_text: generatedCard.front_text,
        front_lang: generatedCard.back_lang || learning_language,
        back_lang: generatedCard.front_lang || known_language,
        front_audio_path: generatedCard.back_audio_path,
        back_audio_path: generatedCard.front_audio_path
      };

      // Save both cards to the deck using the consolidated addCardToDeck function
      await addCardToDeck(deckId, [firstCard, secondCard]);
      
      clearInput(); // Reset the form
      handleCloseModal(); // Close the modal after adding
    } catch (err) {
      console.error('Error adding cards to deck:', err);
      setError(`Failed to add cards: ${err.message}`);
    }
  };

  return (
    <div className="card-modal-overlay" onClick={handleBackdropClick}>
      <div className="card-modal-content" ref={modalRef}>
        <div className="card-modal-header">
          <h3>New Translation Pair</h3>
          <button onClick={handleCloseModal} className="card-modal-close-btn">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="card-modal-body">
          {error && <div className="error-message">{error}</div>}

        <p className="language-info">
          {getLanguageDisplay(currentDeck.known_language).name} → {getLanguageDisplay(currentDeck.learning_language).name}
        </p>
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

        <p className="language-info">
          {getLanguageDisplay(currentDeck.learning_language).name} → {getLanguageDisplay(currentDeck.known_language).name}
        </p>
          <div className="flashcard">
            <div className="card-side">
              <h3>Front</h3>
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
            <div className="card-side">
              <h3>Back</h3>
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
          </div>

          <button
            onClick={handleAddToDeck}
            className="add-to-deck-btn"
          >
            Add to Deck
          </button>
        </div>
      </div>
    </div>
  );
};

export default CardModal; 