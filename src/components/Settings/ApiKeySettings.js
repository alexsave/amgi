import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './Settings.css';

export default function ApiKeySettings() {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const { isDirectMode, enableDirectMode, disableDirectMode } = useAuth();

  useEffect(() => {
    if (isDirectMode) {
      setApiKey('********');
    } else {
      setApiKey('');
    }
  }, [isDirectMode]);

  const handleSubmit = (e) => {
    e.preventDefault();
    try {
      if (isDirectMode && !apiKey.trim()) {
        setError('API key is required when using direct API access');
        return;
      }

      if (apiKey === '********') {
        return; // No change needed
      }

      if (apiKey.trim()) {
        enableDirectMode(apiKey.trim());
      } else {
        disableDirectMode();
      }

      setError('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="settings-section">
      <h3>API Access Settings</h3>
      {error && <div className="settings-error">{error}</div>}
      {saved && <div className="settings-success">Settings saved!</div>}
      <form onSubmit={handleSubmit}>
        <div className="settings-group">
          <label>
            <input
              type="checkbox"
              checked={isDirectMode}
              onChange={(e) => {
                if (!e.target.checked) {
                  disableDirectMode();
                  setApiKey('');
                  setError('');
                }
              }}
            />
            Use my own OpenAI API key
          </label>
          <p className="settings-help">
            If enabled, all API calls will be made directly to OpenAI using your key.
            Your data will be saved locally.
          </p>
        </div>

        {isDirectMode && (
          <div className="settings-group">
            <label>OpenAI API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="settings-input"
            />
            <p className="settings-help">
              Your API key will be stored securely in your browser's local storage.
              Never share your API key with others.
            </p>
          </div>
        )}

        <button type="submit" className="settings-button">
          Save Settings
        </button>
      </form>
    </div>
  );
} 