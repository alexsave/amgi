import React, { useState, useEffect } from 'react';
import { getApiMode, setApiMode } from '../../network/api';
import './Settings.css';

export default function ApiKeySettings() {
  const [useDirectApi, setUseDirectApi] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const mode = getApiMode();
    setUseDirectApi(mode.useDirectApi);
    setApiKey(mode.apiKey || '');
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    try {
      if (useDirectApi && !apiKey.trim()) {
        setError('API key is required when using direct API access');
        return;
      }

      setApiMode(useDirectApi, apiKey.trim());
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
              checked={useDirectApi}
              onChange={(e) => {
                setUseDirectApi(e.target.checked);
                if (!e.target.checked) {
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

        {useDirectApi && (
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