import React from 'react';
import { useNavigate, Routes, Route, Navigate } from 'react-router-dom';
import DeckList from './Deck/DeckList';
import CardList from './Card/CardList';
import ReviewMode from './Review/ReviewMode';
import VoiceMode from './Review/VoiceMode';
import Settings from './Settings/Settings';
import Navbar from './Navigation/Navbar';
import { AudioProvider } from '../contexts/useAudio';
import { ReviewProvider } from '../contexts/ReviewContext';
import { RealtimeProvider } from '../contexts/RealtimeContext';
import { useDecks } from '../contexts/DeckContext';

function AppContent() {
  const navigate = useNavigate();
  const { setCurrentDeckId } = useDecks();

  const handleBackToList = () => {
    setCurrentDeckId(null);
    navigate('/decks');
  };

  return (
    <div className="app-container">
      <Navbar />
      <div className="app-content">
        <AudioProvider>
          <ReviewProvider>
            <Routes>
              <Route path="/" element={<Navigate to="/decks" replace />} />
              <Route path="/decks" element={<DeckList />} />
              <Route path="/settings" element={<Settings />} />

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
                  <ReviewMode onBack={handleBackToList} />
                }
              />

              <Route
                path="/deck/:id/voice"
                element={
                  <RealtimeProvider>
                    <VoiceMode />
                  </RealtimeProvider>
                }
              />
            </Routes>
          </ReviewProvider>
        </AudioProvider>
      </div>
    </div>
  );
}

export default AppContent; 