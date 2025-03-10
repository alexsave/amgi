import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import ApiKeySettings from '../Settings/ApiKeySettings';
import './Navbar.css';
import { NAME } from '../../constants/names';

export default function Navbar() {
  const { signOut, user } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [signOutStatus, setSignOutStatus] = useState('');
  const [signOutError, setSignOutError] = useState('');

  const handleSignOut = async () => {
    try {
      setSignOutStatus('Signing out...');
      setSignOutError('');
      await signOut();
      setSignOutStatus('Signed out successfully');
      setTimeout(() => setSignOutStatus(''), 3000); // Clear success message after 3 seconds
    } catch (error) {
      console.error('Error signing out:', error);
      setSignOutStatus('');
      
      // Check if user is still authenticated or not to determine if sign out worked
      // despite errors
      if (!user) {
        setSignOutStatus('Signed out successfully (with recoverable errors)');
        setTimeout(() => setSignOutStatus(''), 3000);
      } else {
        setSignOutError(error.message || 'An unknown error occurred');
      }
    }
  };

  const clearError = () => {
    setSignOutError('');
  };

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand">
          {NAME} <span className="beta-tag" style={{ fontFamily: 'Courier New', fontSize: '0.8rem' }}>Dev</span>
        </div>
        <div className="navbar-actions">
          {signOutStatus && <span className="status-message">{signOutStatus}</span>}
          <button 
            className="navbar-button"
            onClick={() => setShowSettings(!showSettings)}
          >
            Settings
          </button>
          <button 
            className="navbar-button"
            onClick={handleSignOut}
          >
            Sign Out
          </button>
        </div>
      </nav>
      
      {signOutError && (
        <div className="error-overlay">
          <div className="error-container">
            <div className="error-header">
              <h3>Sign Out Error</h3>
              <button className="close-button" onClick={clearError}>×</button>
            </div>
            <div className="error-content">
              <p>{signOutError}</p>
            </div>
          </div>
        </div>
      )}
      
      {showSettings && (
        <div className="settings-overlay">
          <div className="settings-modal">
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button 
                className="close-button"
                onClick={() => setShowSettings(false)}
              >
                ×
              </button>
            </div>
            <ApiKeySettings />
          </div>
        </div>
      )}
    </>
  );
} 