import React from 'react';
import './App.css';
import { DeckProvider } from './contexts/DeckContext';
import AppContent from './components/AppContent';

function App() {
  return (
    <DeckProvider>
      <AppContent />
    </DeckProvider>
  );
}

export default App; 