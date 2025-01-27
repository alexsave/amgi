import React from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useDeckContext } from '../contexts/DeckContext';
import DeckList from './Deck/DeckList';
import CardList from './Card/CardList';
import ReviewMode from './Review/ReviewMode';
import { RealtimeProvider } from '../contexts/RealtimeContext';
import Navbar from './Navigation/Navbar';

function AppContent() {
  const { currentDeck, decks } = useDeckContext();
  const navigate = useNavigate();

  const handleBackToList = () => {
    navigate('/decks');
  };

  return (
    <div className="app-container">
      <Navbar />
      <div className="app-content">
        <RealtimeProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/decks" replace />} />
            <Route path="/decks" element={<DeckList />} />
            
            <Route 
              path="/deck/:id" 
              element={
                <CardList
                  onBack={handleBackToList}
                  onCardClick={(card) => console.log('Card clicked:', card)}
                />
              } 
            />

            <Route 
              path="/deck/:id/review" 
              element={
                <ReviewMode
                  onBack={handleBackToList}
                />
              } 
            />
          </Routes>
        </RealtimeProvider>
      </div>
    </div>
  );
}

export default AppContent; 