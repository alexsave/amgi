import React, { useState, useEffect } from 'react';
import { NAME } from '../../constants/names';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import './DirectAccess.css';

export default function DirectAccess() {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { user, isDirectMode, enableDirectMode } = useAuth();

  useEffect(() => {
    // If user is authenticated or in direct mode, redirect to decks
    if (user || isDirectMode) {
      navigate('/decks', { replace: true });
    }
  }, [user, isDirectMode, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError('Please enter your OpenAI API key');
      return;
    }

    try {
      enableDirectMode(apiKey);
      navigate('/decks', { replace: true });
    } catch (err) {
      setError('Failed to set API key: ' + err.message);
    }
  };

  // Don't render anything while checking authentication or if already in direct mode
  if (user || isDirectMode) {
    return null;
  }

  return (
    <div className="direct-access-container">
      <div className="direct-access-card">
        <h1>Welcome to {NAME}</h1>
        <p className="intro-text">
          Get started quickly by providing your OpenAI API key, or <Link to="/login">sign in</Link> for cloud sync.
        </p>
        
        <form onSubmit={handleSubmit} className="api-key-form">
          <div className="form-group">
            <label htmlFor="apiKey">OpenAI API Key</label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="api-key-input"
            />
            <p className="help-text">
              Your API key will be stored securely in your browser.
              Get your API key from the <a href="https://platform.openai.com/account/api-keys" target="_blank" rel="noopener noreferrer">OpenAI dashboard</a>.
            </p>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="submit-button">
            Start Using {NAME}
          </button>

          <div className="auth-prompt">
            Want cloud sync? <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link>
          </div>
        </form>
      </div>
    </div>
  );
} 