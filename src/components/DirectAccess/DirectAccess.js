import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import CardForm from '../Card/CardForm';
import { setApiMode } from '../../network/api';
import './DirectAccess.css';

export default function DirectAccess() {
  const [apiKey, setApiKey] = useState('');
  const [isKeySet, setIsKeySet] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError('Please enter your OpenAI API key');
      return;
    }

    try {
      setApiMode(true, apiKey.trim());
      setIsKeySet(true);
    } catch (err) {
      setError('Failed to set API key: ' + err.message);
    }
  };

  if (isKeySet) {
    return (
      <div className="direct-access-container">
        <div className="direct-header">
          <h1>AMGI - Direct Access Mode</h1>
          <div className="auth-prompt">
            Want to save your decks? <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link>
          </div>
        </div>
        <CardForm directMode={true} />
      </div>
    );
  }

  return (
    <div className="direct-access-container">
      <div className="direct-access-card">
        <h1>Welcome to AMGI</h1>
        <p className="intro-text">
          Get started quickly by providing your OpenAI API key, or <Link to="/login">sign in</Link> for full access.
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
            Want full access? <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link>
          </div>
        </form>
      </div>
    </div>
  );
} 