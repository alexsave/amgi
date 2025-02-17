import React from 'react';
import { useDecks } from '../../contexts/DeckContext';
import './Timeline.css';

export default function Timeline() {
  const { decks, currentDeck, dueCards, currentCardIndex } = useDecks();
  const deck = decks[currentDeck];

  if (!deck) return null;

  const now = new Date();
  
  // Calculate max interval in the deck
  const intervals = deck.cards
    .filter(card => card.nextReview || card.lastReviewed)
    .map(card => {
      const reviewDate = new Date(card.nextReview || card.lastReviewed);
      return Math.abs((reviewDate - now) / (1000 * 60 * 60)); // hours
    });
  const maxHoursDiff = Math.max(...intervals, 24); // minimum 24h for scale
  const maxLogValue = Math.log2(maxHoursDiff + 1);

  return (
    <div className="timeline-container">
      <div className="timeline">
        <div className="timeline-line"></div>
        <div 
          className="timeline-now"
          style={{ left: '0%' }}
        ></div>
        {deck.cards.map((card) => {
          // Skip cards without a next review date
          if (!card.nextReview && !card.lastReviewed) return null;

          // Calculate time difference in hours
          const reviewDate = new Date(card.nextReview || card.lastReviewed);
          const hoursDiff = (reviewDate - now) / (1000 * 60 * 60);
          
          // Use logarithmic scale for position
          // Add 1 to handle negative values (past due cards)
          const logPosition = Math.log2(Math.abs(hoursDiff) + 1);
          
          // Calculate position percentage
          // Past due cards: 0-10%
          // Future cards: 10-100%
          let position;
          if (hoursDiff < 0) {
            // Past due cards in reverse log scale in 0-10% range
            position = 10 - (logPosition / maxLogValue) * 10;
          } else {
            // Future cards in log scale in 10-100% range
            position = 10 + (logPosition / maxLogValue) * 90;
          }
          
          // Clamp position between 0 and 100
          const clampedPosition = Math.max(0, Math.min(100, position));

          // Find if this card is in the due cards list
          const dueIndex = dueCards.findIndex(c => c.created === card.created);
          const isCurrent = dueIndex === currentCardIndex;
          const isDue = dueIndex !== -1;

          return (
            <div
              key={card.created}
              className={`timeline-card ${isCurrent ? 'current' : ''} ${isDue ? 'due' : ''}`}
              style={{ left: `${clampedPosition}%` }}
            >
              <div className="front-text">{card.front_text}</div>
              <div className="stats">
                Ease: {card.easeFactor?.toFixed(2) || 2.5}<br />
                Interval: {card.interval || 0} days<br />
                Next: {new Date(card.nextReview || card.lastReviewed).toLocaleDateString()}<br />
                {hoursDiff < 0 ? `${Math.abs(Math.round(hoursDiff))}h overdue` : 
                 hoursDiff < 24 ? `in ${Math.round(hoursDiff)}h` :
                 `in ${Math.round(hoursDiff / 24)}d`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
} 