import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { XMarkIcon, ArrowPathIcon, PencilSquareIcon, MicrophoneIcon } from '@heroicons/react/24/outline';
import { useAudio } from '../../hooks/useAudio';
import { useDecks } from '../../contexts/DeckContext';
import { useCardGenerationContext } from '../../contexts/CardGenerationContext';
import { getLanguageDisplay } from '../../constants/languages';
import './CardModal.css';

const CardModal = ({ isOpen, onClose }) => {
  const { id: deckId } = useParams();
  const { playAudio } = useAudio();
  const { decks, addCardToDeck, currentDeckId } = useDecks();
  const { 
    generatedCard,
    clearGeneratedCard,
    clearInput,
    setEditableText,
    updateCardText,
    regenerateCardPart,
    isGenerating,
    regeneratingParts
  } = useCardGenerationContext();
  const modalRef = useRef(null);

  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState({ front: false, back: false });
  
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
      setEditMode({ front: false, back: false });
    }
  }, [isOpen]);

  // Handle modal close cleanly
  const handleCloseModal = () => {
    setError(null);
    onClose();
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

  // Add loading content render function
  const renderLoadingCardContent = () => (
    <div className="card-content loading">
      <div className="loading-text-area">
        <ArrowPathIcon className="h-5 w-5 spin" />
      </div>
      <div className="card-actions">
        <button className="card-action-btn" disabled>
          <PencilSquareIcon className="h-5 w-5" />
        </button>
        <button className="card-action-btn" disabled>
          <ArrowPathIcon className="h-5 w-5" />
        </button>
        <button className="play-audio-btn loading" disabled>
          <ArrowPathIcon className="h-5 w-5 spin" />
          <span>Audio</span>
        </button>
        <button className="card-action-btn" disabled>
          <ArrowPathIcon className="h-5 w-5" />
        </button>
        <button className="card-action-btn" disabled>
          <MicrophoneIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );

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

  // Render card content with action buttons
  const renderCardContent = (textPart, audioPart) => {
    const isTextRegenerating = regeneratingParts.includes(textPart);
    const isAudioRegenerating = regeneratingParts.includes(audioPart);
    
    return (
      <div className="card-content">
        <div className="edit-text-container">
          {isGenerating ? (
            <div className="loading-text-area">
              <ArrowPathIcon className="h-5 w-5 spin" />
            </div>
          ) : (
            <textarea
              value={generatedCard[textPart]}
              onChange={(e) => handleTextChange(textPart, e.target.value)}
              className="edit-text-area"
            />
          )}
        </div>

        <div className="card-actions">

          <button
            className="card-action-btn"
            onClick={() => handleRegeneratePart(textPart)}
            disabled={isGenerating}
            title={`Regenerate ${textPart === 'front_text' ? 'front' : 'back'} text`}
          >
            <ArrowPathIcon className={`h-5 w-5 ${isTextRegenerating ? 'spin' : ''}`} />
          </button>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {isGenerating ? (
                <div className="loading-text-area">
                  <ArrowPathIcon className="h-5 w-5 spin" />
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
                title={`Regenerate ${audioPart === 'front_audio_path' ? 'front' : 'back'} audio`}
              >
                <ArrowPathIcon className={`h-5 w-5 ${isAudioRegenerating ? 'spin' : ''}`} />
              </button>

              <button
                className="card-action-btn"
                title="Record your own audio"
                disabled={isGenerating}
              >
                <MicrophoneIcon className="h-5 w-5" />
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
          <h3>New Translation Pair</h3>
          <button onClick={handleCloseModal} className="card-modal-close-btn">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="card-modal-body">
          {error && <div className="error-message">{error}</div>}

          {(false && !generatedCard) ? (
            <>
              <p className="language-info">
                {getLanguageDisplay(currentDeck.known_language).name} → {getLanguageDisplay(currentDeck.learning_language).name}
              </p>
              <div className="flashcard">
                <div className="card-side">
                  <h3>Front</h3>
                  {renderLoadingCardContent()}
                </div>
                <div className="card-side">
                  <h3>Back</h3>
                  {renderLoadingCardContent()}
                </div>
              </div>

              <p className="language-info">
                {getLanguageDisplay(currentDeck.learning_language).name} → {getLanguageDisplay(currentDeck.known_language).name}
              </p>
              <div className="flashcard">
                <div className="card-side">
                  <h3>Front</h3>
                  {renderLoadingCardContent()}
                </div>
                <div className="card-side">
                  <h3>Back</h3>
                  {renderLoadingCardContent()}
                </div>
              </div>

              <button className="add-to-deck-btn" disabled>
                Add to Deck
              </button>
            </>
          ) : (
            <>
              <p className="language-info">
                {getLanguageDisplay(currentDeck.known_language).name} → {getLanguageDisplay(currentDeck.learning_language).name}
              </p>
              <div className="flashcard">
                <div className="card-side">
                  <h3>Front</h3>
                  {renderCardContent(
                    'front_text',
                    'front_audio_path'
                  )}
                </div>
                <div className="card-side">
                  <h3>Back</h3>
                  {renderCardContent(
                    'back_text',
                    'back_audio_path'
                  )}
                </div>
              </div>

              <p className="language-info">
                {getLanguageDisplay(currentDeck.learning_language).name} → {getLanguageDisplay(currentDeck.known_language).name}
              </p>
              <div className="flashcard">
                <div className="card-side">
                  <h3>Front</h3>
                  {renderCardContent(
                    'back_text',
                    'back_audio_path'
                  )}
                </div>
                <div className="card-side">
                  <h3>Back</h3>
                  {renderCardContent(
                    'front_text',
                    'front_audio_path'
                  )}
                </div>
              </div>

              <button
                onClick={handleAddToDeck}
                className="add-to-deck-btn"
                disabled={isGenerating}
              >
                Add to Deck
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CardModal; 