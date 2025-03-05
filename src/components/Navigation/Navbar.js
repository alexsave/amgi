import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import ApiKeySettings from '../Settings/ApiKeySettings';
import './Navbar.css';
import { NAME } from '../../constants/names';

export default function Navbar() {
  const { signOut } = useAuth();
  const [showSettings, setShowSettings] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand">
          {NAME} <span className="beta-tag" style={{ fontFamily: 'Courier New', fontSize: '0.8rem' }}>Dev</span>
        </div>
        <div className="navbar-actions">
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