import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../contexts/AuthContext';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import './Navbar.css';
import { NAME } from '../../constants/names';

// The badge exists to say "this is not the real thing", so it must not appear
// on the real thing. NODE_ENV is 'development' under `next dev` and
// 'production' in any built deployment; NEXT_PUBLIC_APP_ENV lets a preview
// deployment label itself without pretending to be production.
const ENV_BADGE =
  process.env.NEXT_PUBLIC_APP_ENV || (process.env.NODE_ENV === 'production' ? '' : 'Dev');

export default function Navbar() {
  const router = useRouter();
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
    router.push('/settings');
  };

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand">
          {NAME}
          {ENV_BADGE && (
            <span className="beta-tag" style={{ fontFamily: 'Courier New', fontSize: '0.8rem' }}>
              {' '}{ENV_BADGE}
            </span>
          )}
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