import React from 'react';
import { useDeckContext } from '../contexts/DeckContext';
import { REVIEW_MODES } from '../utils/constants';
import DeckList from './Deck/DeckList';
import CardForm from './Card/CardForm';
import CardList from './Card/CardList';
import ReviewMode from './Review/ReviewMode';
import { RealtimeProvider } from '../contexts/RealtimeContext';
import Navbar from './Navigation/Navbar';

function AppContent() {
  const { mode, currentDeck, decks, setMode } = useDeckContext();

  const handleBackToList = () => {
    setMode(REVIEW_MODES.LIST);
  };

  const handleCardClick = (card) => {
    // For now, we'll just log the card. You can add more functionality later
    console.log('Card clicked:', card);
  };

  return (
    <div className="app-container">
      <Navbar />
      <div className="app-content">
        <RealtimeProvider>
          {mode === REVIEW_MODES.LIST && (
            <DeckList />
          )}
          {mode === REVIEW_MODES.CREATE && (
            <CardForm onBack={handleBackToList} />
          )}
          {mode === REVIEW_MODES.VIEW && currentDeck && (
            <CardList
              deck={currentDeck}
              onBack={handleBackToList}
              onCardClick={handleCardClick}
            />
          )}
          {mode === REVIEW_MODES.REVIEW && currentDeck && (
            <ReviewMode
              deck={currentDeck}
              onBack={handleBackToList}
            />
          )}
        </RealtimeProvider>
      </div>
    </div>
  );
}

export default AppContent; 