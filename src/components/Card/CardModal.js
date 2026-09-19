import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { XMarkIcon, ArrowPathIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { useAudio } from '../../contexts/useAudio';
import { useDecks } from '../../contexts/DeckContext';
import { useCardGenerationContext } from '../../contexts/CardGenerationContext';
import { getLanguageDisplay } from '../../constants/languages';
import './CardModal.css';

const CardModal = ({ isOpen, onClose }) => {
  const { id: deckId } = useParams();
  const { playAudio } = useAudio();
  const { decks, addCardToDeck } = useDecks();
  const {
    generatedCard,
    clearInput,
    setEditableText,
    updateCardText,
    regenerateCardPart,
    isGenerating,
    regeneratingParts
  } = useCardGenerationContext();
  const modalRef = useRef(null);

  const [error, setError] = useState('');

  const currentDeck = decks[deckId];

  // Every exit clears the error, so the modal never reopens showing the
  // failure from last time.
  const handleCloseModal = useCallback(() => {
    setError(null);
    onClose();
  }, [onClose]);

  // Close on escape key
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isOpen) {
        handleCloseModal();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => document.removeEventListener('keydown', handleEscKey);
  }, [isOpen, handleCloseModal]);

  // Handle clicking outside modal
  const handleBackdropClick = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      handleCloseModal();
    }
  };

  // Handle regenerating a part of the card
  const handleRegeneratePart = async (part) => {
    if (!generatedCard) return;

    try {
      const { known_language, learning_language } = currentDeck;
      await regenerateCardPart([part], known_language, learning_language);
    } catch (err) {
      console.error('Error regenerating card part:', err);
      setError(`Failed to regenerate: ${err.message}`);
    }
  };

  // Add this function to handle adding cards with missing audio
  const handleAddToDeckWithoutAudio = () => {
    if (!generatedCard) {
      setError('No card data to add');
      return;
    }
    
    // Says what actually happens in review, rather than implying the card is
    // merely a bit worse: a card with no audio cannot be played, so the loop
    // shows the text and asks the learner to read it. Audio can be filled in
    // later from the deck's card list.
    if (!window.confirm(
      'Some audio could not be generated.\n\n' +
      'Cards without audio are not played in review - they show their text to read out loud instead. ' +
      'You can generate the audio later.\n\nAdd them anyway?'
    )) {
      return;
    }
    
    // Create cards without the missing audio
    const firstCard = {
      front_text: generatedCard.front_text,
      back_text: generatedCard.back_text,
      front_lang: generatedCard.front_lang || currentDeck.known_language,
      back_lang: generatedCard.back_lang || currentDeck.learning_language,
      front_audio_path: generatedCard.front_audio_path || null,
      back_audio_path: generatedCard.back_audio_path || null
    };

    const secondCard = {
      front_text: generatedCard.back_text,
      back_text: generatedCard.front_text,
      front_lang: generatedCard.back_lang || currentDeck.learning_language,
      back_lang: generatedCard.front_lang || currentDeck.known_language,
      front_audio_path: generatedCard.back_audio_path || null,
      back_audio_path: generatedCard.front_audio_path || null
    };

    // Add cards without audio
    addCardToDeck(deckId, [firstCard, secondCard])
      .then(() => {
        clearInput();
        handleCloseModal();
      })
      .catch(err => {
        console.error('Error adding cards to deck:', err);
        setError(`Failed to add cards: ${err.message}`);
      });
  };

  // Handle text change
  const handleTextChange = (part, value) => {
    if (part === 'front_text') {
      updateCardText('front_text', value);
      setEditableText(prev => ({ ...prev, front: value }));
    } else if (part === 'back_text') {
      updateCardText('back_text', value);
      setEditableText(prev => ({ ...prev, back: value }));
    }
  };

  if (!isOpen) return null;

  // If deck doesn't exist, don't show the modal
  if (!currentDeck) return null;

  const { known_language = 'en', learning_language = 'ko' } = currentDeck;
  const knownLanguageDisplay = getLanguageDisplay(known_language).name;
  const learningLanguageDisplay = getLanguageDisplay(learning_language).name;

  const handleAddToDeck = async () => {
    if (!generatedCard) {
      setError('No card data to add');
      return;
    }
    try {
      // Check if audio paths exist
      const missingAudio = !generatedCard.front_audio_path || !generatedCard.back_audio_path;
      
      if (missingAudio) {
        setError('Some audio could not be generated. Regenerate it with the 🔄 button, or add the cards without audio - they will be shown to read rather than played.');
        return; // Don't proceed with normal add
      }
      
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

  // Render card content with action buttons
  const renderCardContent = (textPart, audioPart, language) => {
    const isTextRegenerating = regeneratingParts.includes(textPart);
    const isAudioRegenerating = regeneratingParts.includes(audioPart);

    return (
      <div className="card-content">
        <div className="edit-text-container">
          {isGenerating || !generatedCard ? (
            <div className="loading-text-area">
              <ArrowPathIcon className="icon spin" />
            </div>
          ) : (
            <textarea
              value={generatedCard[textPart] ?? ''}
              onChange={(e) => handleTextChange(textPart, e.target.value)}
              className="edit-text-area"
            />
          )}
        </div>

        <div className="card-actions">
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-evenly' }}>
            <button
              className="card-action-btn"
              onClick={() => handleRegeneratePart(textPart)}
              disabled={isGenerating}
              title={`Regenerate ${language} text`}
            >
              <ArrowPathIcon className={`icon ${isTextRegenerating ? 'spin' : ''}`} />
            </button>

            {isGenerating || !generatedCard ? (
              <div className="play-audio-btn">
                <ArrowPathIcon className="icon spin" />
              </div>
            ) : (
              <button
                className="play-audio-btn"
                onClick={() => playAudio(generatedCard[audioPart])}
                disabled={isGenerating}
              >
                🔊
              </button>
            )}

            <button
              className="card-action-btn"
              onClick={() => handleRegeneratePart(audioPart)}
              disabled={isGenerating}
              title={`Regenerate ${language} audio`}
            >
              <ArrowPathIcon className={`icon ${isAudioRegenerating ? 'spin' : ''}`} />
            </button>

          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="card-modal-overlay" onClick={handleBackdropClick}>
      <div className="card-modal-content" ref={modalRef}>
        <div className="card-modal-header">
          <h3>Edit New Translation Pair</h3>
          <button onClick={handleCloseModal} className="card-modal-close-btn">
            <XMarkIcon className="icon" />
          </button>
        </div>

        <div className="card-modal-body">
          {error && <div className="error-message">{error}</div>}
          
          <div className="bidirectional-hint">
            <small>Creates cards in both directions</small>
          </div>

          <div className="flashcard-container">
            <div className="card-side">
              <h3>{knownLanguageDisplay}</h3>
              {renderCardContent(
                'front_text',
                'front_audio_path',
                knownLanguageDisplay
              )}
            </div>
            
            <div className="card-sides-arrow">
              <ArrowsRightLeftIcon className="bidirectional-arrow" />
            </div>
            
            <div className="card-side">
              <h3>{learningLanguageDisplay}</h3>
              {renderCardContent(
                'back_text',
                'back_audio_path',
                learningLanguageDisplay
              )}
            </div>
          </div>
          
          <small className="ai-disclosure">Audio is AI-generated, not human voice</small>
        </div>
        <div className="card-modal-footer">
          <button
            onClick={handleAddToDeck}
            className="add-to-deck-btn"
            disabled={isGenerating}
          >
            Add to Deck
          </button>

          {/* Add this button that appears only when there's an audio error */}
          {error && error.includes('audio') && (
            <button
              onClick={handleAddToDeckWithoutAudio}
              className="add-to-deck-btn add-without-audio"
              disabled={isGenerating}
            >
              Add Without Audio
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CardModal; 