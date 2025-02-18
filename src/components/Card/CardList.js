import React from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import './CardList.css';

const CardList = ({ onCardClick, onBack }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { decks, addCardToDeck, deleteCard, currentDeckId } = useDecks();

  if (id !== currentDeckId) {
    return <Navigate to="/decks" replace />;
  }
  const deck = decks[id];
/*
  if (!id) {
    console.log('No deck ID found');
  }
  if (!deck) {
    console.log('No deck found');
  }

  if (!id || !deck) {
    return <Navigate to="/decks" replace />;
  }*/

  const handleReview = () => {
    navigate(`/deck/${id}/review`);
  };

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <button onClick={onBack} className="back-btn">← Back</button>
        <h3>{deck.name}</h3>
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
    </div>
  );
};

export default CardList; 