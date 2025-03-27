import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { DeckProvider } from './contexts/DeckContext';
import { CardGenerationProvider } from './contexts/CardGenerationContext';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import Welcome from './components/Welcome/Welcome';
import Signup from './components/Auth/Signup';
import AppContent from './components/AppContent';
import SubscriptionComponent from './components/Subscription/SubscriptionComponent';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={
            <div className="App">
              <Welcome />
            </div>
          } />
          <Route path="/signup" element={
            <div className="App">
              <Signup />
            </div>
          } />
          <Route path="/subscription" element={<ProtectedRoute><SubscriptionComponent /></ProtectedRoute>} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <DeckProvider>
                  <CardGenerationProvider>
                    <div className="App">
                      <AppContent />
                    </div>
                  </CardGenerationProvider>
                </DeckProvider>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App; 