import React from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useDeckContext } from '../../contexts/DeckContext';
import { PlusIcon } from '@heroicons/react/24/outline';
import CardForm from './CardForm';
import './CardList.css';

const CardList = ({ onCardClick, onBack }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { decks } = useDeckContext();
  
  if (!id || !decks[id]) {
    return <Navigate to="/decks" replace />;
  }

  const deck = decks[id];

  const handleReview = () => {
    navigate(`/app/deck/${id}/review`);
  };

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <button onClick={onBack} className="back-btn">← Back</button>
        <h3>{deck.name}</h3>
        {deck.cards.length > 0 && (
          <button onClick={handleReview} className="review-btn">
            Start Review
          </button>
        )}
      </div>

      <div className="deck-content">
        <div className="deck-form">
          <h3>Add New Card</h3>
          <CardForm />
        </div>

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
                  key={cardData.created} 
                  className="card-item"
                  onClick={() => onCardClick(cardData)}
                >
                  <span>Card {index + 1}</span>
                  <small>{cardData.frontText}</small>
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
    </div>
  );
};

export default CardList; 