import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { DeckProvider } from './contexts/DeckContext';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import DirectAccess from './components/DirectAccess/DirectAccess';
import Login from './components/Auth/Login';
import Signup from './components/Auth/Signup';
import AppContent from './components/AppContent';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<DirectAccess />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <DeckProvider>
                  <div className="App">
                    <AppContent />
                  </div>
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