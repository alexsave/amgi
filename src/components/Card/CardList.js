import React from 'react';
import { useDeckContext } from '../../contexts/DeckContext';
import './CardList.css';

const CardList = ({ onCardClick }) => {
  const { currentDeck, decks } = useDeckContext();
  
  if (!currentDeck || !decks[currentDeck]) {
    return null;
  }

  const deck = decks[currentDeck];

  if (deck.cards.length === 0) {
    return null;
  }

  return (
    <div className="deck-cards">
      <h3>Cards in Deck</h3>
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
    </div>
  );
};

export default CardList; 