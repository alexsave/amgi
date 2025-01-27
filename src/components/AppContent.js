import React from 'react';
import { useDeckContext } from '../contexts/DeckContext';
import { REVIEW_MODES } from '../utils/constants';
import DeckList from './Deck/DeckList';
import CardForm from './Card/CardForm';
import CardList from './Card/CardList';
import ReviewMode from './Review/ReviewMode';
import { RealtimeProvider } from '../contexts/RealtimeContext';

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
    <RealtimeProvider>
      <div className="App">
        <h1>AMGI</h1>
        
        {mode === REVIEW_MODES.LIST && <DeckList />}

        {mode === REVIEW_MODES.EDIT && currentDeck && (
          <>
            <div className="mode-header">
              <button onClick={handleBackToList} className="back-btn">← Back to Decks</button>
              <h2>Editing: {decks[currentDeck].name}</h2>
            </div>
            <CardForm />
            <CardList onCardClick={handleCardClick} />
          </>
        )}

        {mode === REVIEW_MODES.REVIEW && currentDeck && <ReviewMode />}
      </div>
    </RealtimeProvider>
  );
}

export default AppContent; 