import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import supabase from '../../db/supabaseClient';
import './Auth.css';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();

    if (password !== confirmPassword) {
      return setError('Passwords do not match');
    }

    try {
      setError('');
      setLoading(true);
      console.log('Submitting signup for email:', email);
      const userData = await signUp(email, password);
      console.log('Signup completed, user data:', userData);
      
      // Show verification message instead of trying to sign in
      setVerificationSent(true);
    } catch (err) {
      console.error('Signup error:', err);
      setError('Failed to create an account: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // If verification email has been sent, show the verification message
  if (verificationSent) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h2>Verify Your Email</h2>
          <div className="auth-success">
            <p>We've sent a verification email to <strong>{email}</strong></p>
            <p>Please check your inbox and click the verification link to complete your signup.</p>
            <p>After verifying your email, you can sign in to access your account.</p>
            <button onClick={() => navigate('/', { replace: true })}>
              Return to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h2>Sign Up</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <div className="form-group">
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <button type="submit" disabled={loading}>
            {loading ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>
        <div className="auth-links">
          <a href="/">Already have an account? Log In</a>
        </div>
      </div>
    </div>
  );
} 