import React, { useState, useEffect } from 'react';
import { NAME } from '../../constants/names';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
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