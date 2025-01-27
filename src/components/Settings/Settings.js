import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getApiMode, setApiMode, getApiKey, setApiKey } from '../../network/apikeyaccess';
import './Settings.css';

export default function Settings() {
  const { user } = useAuth();
  const [useDirectApi, setUseDirectApi] = useState(false);
  const [apiKey, setApiKeyState] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    // Load current API mode and key on mount
    const currentMode = getApiMode();
    setUseDirectApi(currentMode === 'direct');
    
    const currentKey = getApiKey();
    if (currentKey) {
      setApiKeyState('********');
    }
  }, []);

  const handleApiModeChange = (e) => {
    const useDirectMode = e.target.checked;
    setUseDirectApi(useDirectMode);
    setApiMode(useDirectMode ? 'direct' : 'local');
    
    if (!useDirectMode) {
      setApiKeyState('');
      setApiKey(''); // Clear stored API key
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!useDirectApi) {
      return;
    }

    if (!apiKey || apiKey === '********') {
      setError('Please enter a valid OpenAI API key');
      return;
    }

    try {
      // Test the API key here if needed
      setApiKey(apiKey);
      setSuccess('API key saved successfully');
      setApiKeyState('********'); // Mask the key after saving
    } catch (err) {
      setError('Failed to save API key: ' + err.message);
    }
  };

  return (
    <div className="settings-section">
      <h3>API Settings</h3>
      
      <form onSubmit={handleSubmit}>
        <div className="settings-group">
          <label>
            <input
              type="checkbox"
              checked={useDirectApi}
              onChange={handleApiModeChange}
            />
            Use Direct OpenAI API Access
          </label>
          
          <p className="settings-help">
            Enable this option to use your own OpenAI API key directly. This allows you to bypass the server 
            authentication and use the OpenAI API directly from your browser. Your API key will be stored 
            securely in your browser's local storage.
          </p>
        </div>

        {useDirectApi && (
          <div className="settings-group">
            <label htmlFor="apiKey">OpenAI API Key</label>
            <input
              id="apiKey"
              type="password"
              className="settings-input"
              value={apiKey}
              onChange={(e) => setApiKeyState(e.target.value)}
              placeholder="Enter your OpenAI API key"
            />
            <p className="settings-help">
              Enter your OpenAI API key here. You can find your API key in your 
              <a href="https://platform.openai.com/account/api-keys" target="_blank" rel="noopener noreferrer">
                {' '}OpenAI account settings
              </a>.
              Your key will be stored securely in your browser and used only for API requests.
            </p>
          </div>
        )}

        {error && <div className="settings-error">{error}</div>}
        {success && <div className="settings-success">{success}</div>}

        {useDirectApi && (
          <button type="submit" className="settings-button">
            Save API Key
          </button>
        )}
      </form>
    </div>
  );
} 