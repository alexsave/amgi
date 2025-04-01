import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import './Navbar.css';
import { NAME } from '../../constants/names';

export default function Navbar() {
  const navigate = useNavigate();
  const { signOut, user } = useAuth();
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

  const goToSettings = () => {
    navigate('/settings');
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
            className="navbar-button action-btn settings-icon"
            onClick={goToSettings}
            title="Settings"
          >
            <Cog6ToothIcon />
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
    </>
  );
} 