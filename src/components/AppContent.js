import React from 'react';
import { useNavigate, Routes, Route, Navigate } from 'react-router-dom';
import DeckList from './Deck/DeckList';
import CardList from './Card/CardList';
import ReviewMode from './Review/ReviewMode';
import { RealtimeProvider } from '../contexts/RealtimeContext';
import Navbar from './Navigation/Navbar';
import { AudioProvider } from '../contexts/useAudio';
import { ReviewProvider } from '../contexts/ReviewContext';

function AppContent() {
  const navigate = useNavigate();

  const handleBackToList = () => {
    navigate('/decks');
  };

  return (
    <div className="app-container">
      <Navbar />
      <div className="app-content">
        <AudioProvider>
          <ReviewProvider>
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
                  path="/deck/:id/edit"
                  element={
                    <CardList
                      onBack={handleBackToList}
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
          </ReviewProvider>

        </AudioProvider>
      </div>
    </div>
  );
}

export default AppContent; 