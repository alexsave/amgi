import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import './Auth.css';
import '../Welcome/Welcome.css'; // Import Welcome CSS for language pattern

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isAdult, setIsAdult] = useState(false);
  const [hasAcceptedEULA, setHasAcceptedEULA] = useState(false);
  const [hasAcceptedPrivacy, setHasAcceptedPrivacy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();

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

  async function handleSubmit(e) {
    e.preventDefault();

    if (password !== confirmPassword) {
      return setError('Passwords do not match');
    }

    if (!isAdult) {
      return setError('You must be at least 18 years old to use this application');
    }

    if (!hasAcceptedEULA || !hasAcceptedPrivacy) {
      return setError('You must accept both the EULA and Privacy Policy');
    }

    try {
      setError('');
      setLoading(true);
      console.log('Submitting signup for email:', email);
      
      // Pass the additional user metadata
      const userData = await signUp(email, password, {
        isAdult,
        hasAcceptedEULA,
        hasAcceptedPrivacy
      });
      
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
      <div className="auth-container welcome-container">
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
    <div className="auth-container welcome-container">
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
          
          <div className="legal-requirements">
            <div className="checkbox-group">
              <label className="checkbox-container">
                <input 
                  type="checkbox" 
                  checked={isAdult} 
                  onChange={() => setIsAdult(!isAdult)}
                  required
                />
                <span className="checkmark"></span>
                I confirm that I am 18 years of age or older
              </label>
            </div>
            
            <div className="checkbox-group">
              <label className="checkbox-container">
                <input 
                  type="checkbox" 
                  checked={hasAcceptedEULA} 
                  onChange={() => setHasAcceptedEULA(!hasAcceptedEULA)}
                  required
                />
                <span className="checkmark"></span>
                I have read and agree to the <a href="/eula.html" target="_blank" rel="noopener noreferrer">End User License Agreement</a>
              </label>
            </div>
            
            <div className="checkbox-group">
              <label className="checkbox-container">
                <input 
                  type="checkbox" 
                  checked={hasAcceptedPrivacy} 
                  onChange={() => setHasAcceptedPrivacy(!hasAcceptedPrivacy)}
                  required
                />
                <span className="checkmark"></span>
                I have read and agree to the <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
              </label>
            </div>
          </div>
          
          <button className="submit-button" type="submit" disabled={loading}>
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