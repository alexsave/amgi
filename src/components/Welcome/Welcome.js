import React, { useState, useEffect } from 'react';
import { NAME } from '../../constants/names';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { LANGUAGES } from '../../constants/languages';
import './Welcome.css';

export default function Welcome() {
  // Login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // Shared state
  const [error, setError] = useState('');

  // Auth hooks
  const navigate = useNavigate();
  const { user, signIn } = useAuth();

  // Sample phrases or characters from each language - shorter for density
  const languagePhrases = [
    { lang: 'en', text: 'A' },
    { lang: 'zh_cn', text: '文' },
    { lang: 'es', text: 'ñ' },
    { lang: 'fr', text: 'é' },
    { lang: 'pt', text: 'ç' },
    { lang: 'ru', text: 'Я' },
    { lang: 'id', text: 'j' },
    { lang: 'de', text: 'ß' },
    { lang: 'ja', text: 'あ' },
    { lang: 'tr', text: 'ğ' },
    { lang: 'zh_hk', text: '好' },
    { lang: 'vi', text: 'ơ' },
    { lang: 'ko', text: '안' },
    { lang: 'it', text: 'ò' },
    { lang: 'th', text: 'ส' },
    { lang: 'hi', text: 'न' },
    { lang: 'ur', text: 'س' },
    { lang: 'ar', text: 'م' }
  ];

  // Generate cells for the 30x30 grid with checkerboard pattern
  const generateCells = () => {
    const cells = [];
    const rows = 30;
    const cols = 30;
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Checkerboard pattern - only fill alternate cells
        const isFilled = (row + col) % 2 === 0;
        
        if (isFilled) {
          // Get a phrase based on position - ensure it's an integer index
          const phraseIndex = Math.floor((row * cols + col) / 2) % languagePhrases.length;
          cells.push({
            text: languagePhrases[phraseIndex].text,
            filled: true
          });
        } else {
          // Empty cell for checkerboard effect
          cells.push({
            text: '',
            filled: false
          });
        }
      }
    }
    return cells;
  };

  const patternCells = generateCells();

  useEffect(() => {
    // If user is authenticated, redirect to decks
    if (user) {
      navigate('/decks', { replace: true });
    }
  }, [user, navigate]);

  const handleTestAccount = async (e) => {
    e.preventDefault();
    setError('');
    try {
      setLoading(true);
      await signIn('test@amgi.cards', 'password');
      navigate('/decks', { replace: true });
    } catch (err) {
      setError('Failed to sign in with test account: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e) => {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password');
      return;
    }

    try {
      setError('');
      setLoading(true);
      await signIn(email, password);
      navigate('/decks', { replace: true });
    } catch (err) {
      console.error('Sign in error:', err);

      // Special handling for email verification errors
      if (err.message && err.message.includes('Email not confirmed')) {
        setError('Your email has not been verified. Please check your inbox for a verification link.');
      } else {
        setError('Failed to sign in: ' + err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // Don't render anything while checking authentication
  if (user) {
    return null;
  }

  return (
    <div className="welcome-container">
      <div className="language-pattern">
        {patternCells.map((cell, index) => (
          <div 
            key={index} 
            className={`language-cell ${cell.filled ? 'filled' : ''}`}
          >
            {cell.text}
          </div>
        ))}
      </div>
      <div className="welcome-card">
        <h1>Welcome to {NAME}</h1>

        {/* Section 1: Test Account */}
        <button
          onClick={handleTestAccount}
          className="test-account-button"
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Try Test Account'}
        </button>

        {/* Error display */}
        {error && <div className="error-message">{error}</div>}

        {/* Section 2: Regular Sign In */}
        <form onSubmit={handleSignIn} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoComplete="username"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            className="submit-button"
            disabled={loading}
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
          <div className="auth-links">
            <Link to="/signup">Need an account? Sign Up</Link>
          </div>
        </form>
      </div>
    </div>
  );
} 