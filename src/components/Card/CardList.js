import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TrashIcon } from '@heroicons/react/24/outline';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import CardModal from './CardModal';
import './CardList.css';
import { getLanguageDisplay } from '../../constants/languages';

const CardList = ({ onCardClick }) => {
  const { id } = useParams();
  const router = useRouter();
  const { decks, setCurrentDeckId, deleteCard } = useDecks();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [deletingCardId, setDeletingCardId] = useState(null);

  const deck = decks[id];

  const handleBack = () => {
    setCurrentDeckId(null);
    router.push('/decks');
  };

  const closeModal = () => setIsModalOpen(false);
  const handleGenerationStart = () => setIsModalOpen(true);

  // Confirmed the same way a deck deletion is, and the row stays disabled
  // until the server has actually removed the card and its audio.
  const handleDeleteClick = async (e, cardData) => {
    e.stopPropagation();
    if (!window.confirm(`Delete this card?\n\n${cardData.front_text}`)) return;

    setDeletingCardId(cardData.id);
    try {
      await deleteCard(id, cardData.id);
    } catch (err) {
      console.error('Error deleting card:', err);
      alert(`Failed to delete card: ${err.message}`);
    } finally {
      setDeletingCardId(null);
    }
  };

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <button onClick={handleBack} className="back-btn">← Back</button>
        <h1>{deck.name}</h1>
        <p className="language-info">
          {getLanguageDisplay(deck.known_language).flag} {getLanguageDisplay(deck.known_language).name} → {getLanguageDisplay(deck.learning_language).flag} {getLanguageDisplay(deck.learning_language).name}
        </p>
      </div>

      <div className="deck-content">
        <CardForm onGenerationStart={handleGenerationStart} />

        <div className="deck-cards-list">
          <h3>Cards in Deck</h3>
          {deck.cards.length === 0 ? (
            <div className="empty-deck">
              <p>No cards in this deck yet.</p>
            </div>
          ) : (
            <div className="card-list">
              {deck.cards.map((cardData, index) => (
                <div
                  key={cardData.id}
                  className={`card-item${onCardClick ? ' is-clickable' : ''}`}
                  onClick={onCardClick ? () => onCardClick(cardData) : undefined}
                >
                  <div className="card-item-header">
                    <span>Card {index + 1}</span>
                    <button
                      onClick={(e) => handleDeleteClick(e, cardData)}
                      className="card-delete-btn"
                      title="Delete Card"
                      disabled={deletingCardId === cardData.id}
                    >
                      <TrashIcon className="icon" />
                    </button>
                  </div>
                  <small>{cardData.front_text}</small>
                  {cardData.lastReviewed && (
                    <div className="card-stats">
                      <small>
                        Next review: {new Date(cardData.nextReview).toLocaleDateString()}
                        <br />
                        Interval: {cardData.interval} days
                        <br />
                        Ease: {cardData.easeFactor?.toFixed(2)}
                      </small>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <CardModal isOpen={isModalOpen} onClose={closeModal} />
    </div>
  );
};

export default CardList;
