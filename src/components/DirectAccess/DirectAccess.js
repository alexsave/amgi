import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { setApiMode } from '../../network/api';
import './DirectAccess.css';

export default function DirectAccess() {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError('Please enter your OpenAI API key');
      return;
    }

    try {
      localStorage.setItem('useDirectApi', 'true');
      localStorage.setItem('openaiApiKey', apiKey.trim());
      setApiMode(true, apiKey.trim());
      navigate('/app/decks', { replace: true });
    } catch (err) {
      setError('Failed to set API key: ' + err.message);
    }
  };

  return (
    <div className="direct-access-container">
      <div className="direct-access-card">
        <h1>Welcome to AMGI</h1>
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
              Your API key will be stored securely in your browser and used only for API requests.
              Get your API key from the <a href="https://platform.openai.com/account/api-keys" target="_blank" rel="noopener noreferrer">OpenAI dashboard</a>.
            </p>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="submit-button">
            Start Using AMGI
          </button>

          <div className="auth-prompt">
            Want cloud sync? <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link>
          </div>
        </form>
      </div>
    </div>
  );
} 