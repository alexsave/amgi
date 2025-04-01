import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import supabase from '../../db/supabaseClient';
import './Settings.css';

const Settings = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [userPreferences, setUserPreferences] = useState({
    dailyGoal: 50,
    preferredLanguage: 'en',
    notifications: true,
    darkMode: true
  });

  useEffect(() => {
    if (user) {
      loadUserPreferences();
    }
  }, [user]);

  const loadUserPreferences = async () => {
    try {
      const { data, error } = await supabase
        .from('user_preferences')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error) throw error;

      if (data) {
        setUserPreferences({
          dailyGoal: data.daily_goal || 50,
          preferredLanguage: data.preferred_language || 'en',
          notifications: data.notifications_enabled ?? true,
          darkMode: data.dark_mode ?? true
        });
      }
    } catch (error) {
      console.error('Error loading preferences:', error);
      setMessage({ type: 'error', text: 'Failed to load preferences' });
    }
  };

  const handleSave = async () => {
    if (!user) return;

    setIsLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const { error } = await supabase
        .from('user_preferences')
        .upsert({
          user_id: user.id,
          daily_goal: userPreferences.dailyGoal,
          preferred_language: userPreferences.preferredLanguage,
          notifications_enabled: userPreferences.notifications,
          dark_mode: userPreferences.darkMode
        });

      if (error) throw error;

      setMessage({ type: 'success', text: 'Settings saved successfully!' });
    } catch (error) {
      console.error('Error saving preferences:', error);
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setUserPreferences(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="back-button" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h2>Settings</h2>
      </div>

      <div className="settings-content">
        <div className="preferences-section">
          <div className="preference-item">
            <label htmlFor="dailyGoal">Daily Goal (cards)</label>
            <input
              type="number"
              id="dailyGoal"
              name="dailyGoal"
              value={userPreferences.dailyGoal}
              onChange={handleInputChange}
              min="1"
              max="1000"
            />
          </div>

          <div className="preference-item">
            <label htmlFor="preferredLanguage">Preferred Language</label>
            <select
              id="preferredLanguage"
              name="preferredLanguage"
              value={userPreferences.preferredLanguage}
              onChange={handleInputChange}
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ru">Russian</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </div>

          <div className="preference-item checkbox">
            <label htmlFor="notifications">Enable Notifications</label>
            <input
              type="checkbox"
              id="notifications"
              name="notifications"
              checked={userPreferences.notifications}
              onChange={handleInputChange}
            />
          </div>

          <div className="preference-item checkbox">
            <label htmlFor="darkMode">Dark Mode</label>
            <input
              type="checkbox"
              id="darkMode"
              name="darkMode"
              checked={userPreferences.darkMode}
              onChange={handleInputChange}
            />
          </div>
        </div>

        {message.text && (
          <div className={`message ${message.type}`}>
            {message.text}
          </div>
        )}

        <div className="settings-footer">
          <button
            className="save-button"
            onClick={handleSave}
            disabled={isLoading}
          >
            {isLoading ? 'Saving...' : 'Save Changes'}
          </button>
        </div>

        <div className="legal-links">
          <a href="/eula.html" target="_blank" rel="noopener noreferrer">End User License Agreement</a>
          <span className="separator">•</span>
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
};

export default Settings; 