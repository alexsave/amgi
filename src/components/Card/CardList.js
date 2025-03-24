import React, { useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import CardModal from './CardModal';
import './CardList.css';
import { getLanguageDisplay } from '../../constants/languages';

const CardList = ({ onCardClick, onBack }) => {
  const { id } = useParams();
  const { decks, currentDeckId } = useDecks();
  const [isModalOpen, setIsModalOpen] = useState(false);

  if (id !== currentDeckId) {
    return <Navigate to="/decks" replace />;
  }
  const deck = decks[id];

  const closeModal = () => setIsModalOpen(false);
  const handleGenerationStart = () => setIsModalOpen(true);

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <button onClick={onBack} className="back-btn">← Back</button>
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
                  className="card-item"
                  onClick={() => onCardClick(cardData)}
                >
                  <span>Card {index + 1}</span>
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