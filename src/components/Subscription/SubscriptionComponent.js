import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import supabase from '../../db/supabaseClient';
import { useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Navigation/Navbar';
import './SubscriptionComponent.css';

export default function SubscriptionComponent() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  
  // Check if user is in onboarding flow
  const isOnboarding = new URLSearchParams(location.search).get('onboarding') === 'true';
  const [successMessage, setSuccessMessage] = useState('');
  
  // Check if this is an email verification redirect
  useEffect(() => {
    // Email verification redirects will have an auth token in the URL
    if (location.hash.includes('access_token')) {
      console.log('User arrived from email verification');
      setSuccessMessage('Email verified successfully! Please select your subscription plan.');
      
      // Clear the hash from the URL without reloading the page
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [location.hash]);
  
  useEffect(() => {
    console.log('SubscriptionComponent mounted. User:', user?.id);
    
    // Check for success or canceled status from Stripe redirect
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.get('success') === 'true') {
      setSuccessMessage('Subscription updated successfully!');
      // Clear the URL parameter after displaying the message
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
      
      // Refresh subscription data
      if (user) loadSubscriptionData();
    }
    
    if (searchParams.get('canceled') === 'true') {
      setError('Subscription process was canceled.');
      // Clear the URL parameter after displaying the message
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
    }
  }, [location.search]);

  useEffect(() => {
    console.log('User changed in SubscriptionComponent:', user?.id);
    if (user) {
      loadSubscriptionData();
    } else {
      console.warn('No user available in SubscriptionComponent');
    }
  }, [user]);

  async function loadSubscriptionData() {
    try {
      setLoading(true);
      
      if (!user || !user.id) {
        console.error('Cannot load subscription data - user is not defined:', user);
        setError('User authentication issue. Please try logging in again.');
        setLoading(false);
        return;
      }
      
      console.log('Loading subscription data for user:', user.id);
      
      // Load user's current subscription only (tiers are hardcoded)
      const { data: subscriptionData, error: subscriptionError } = await supabase
        .from('user_subscriptions')
        .select('*, subscription_tiers(*)')
        .eq('user_id', user.id)
        .single();
        
      if (subscriptionError && subscriptionError.code !== 'PGRST116') {
        console.error('Error loading subscription:', subscriptionError);
        throw subscriptionError;
      }
      
      console.log('Loaded subscription data:', subscriptionData);
      setSubscription(subscriptionData || null);
    } catch (err) {
      console.error('Failed to load subscription data:', err);
      setError('Failed to load subscription data: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubscribe(priceId, tierName) {
    try {
      setLoading(true);
      
      // For free tier during onboarding, just redirect to dashboard
      if (tierName === 'Free' && isOnboarding && subscription?.subscription_tiers?.name === 'Free') {
        navigate('/');
        return;
      }
      
      // Call server function to create payment link
      const { data, error } = await supabase.functions.invoke('payment-links', {
        body: {
          priceId,
          userId: user.id,
          tierName
        }
      });
      
      if (error) throw error;
      
      // For free tier, might return redirectUrl instead of url
      if (data.redirectUrl) {
        navigate(new URL(data.redirectUrl).pathname + new URL(data.redirectUrl).search);
        return;
      }
      
      // For paid tiers, redirect to the payment link
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No payment link URL returned');
      }
      
    } catch (err) {
      setError('Failed to process subscription: ' + err.message);
      setLoading(false);
    }
  }

  function handleContinueWithFree() {
    navigate('/');
  }

  if (loading) return (
    <div className="subscription-container">
      <div className="loading-spinner">Loading...</div>
    </div>
  );

  // Hardcoded subscription tiers with improved descriptions
  const hardcodedTiers = [
    {
      id: 'free',
      name: 'Free',
      displayPrice: 'Free',
      priceId: 'price_free',
      features: [
        '5 practice sessions per month',
        '100 pronunciation evaluations per month',
        '100 audio generations for cards per month',
        'Unlimited flashcards'
      ]
    },
    {
      id: 'standard',
      name: 'Standard',
      displayPrice: '$30/month',
      priceId: 'price_1R38iGDkEAsn6R9yOrSesptN',
      features: [
        '60 practice sessions per month',
        '1,000 pronunciation evaluations per month',
        '1,000 audio generations for cards per month',
        'Priority support',
        'Unlimited flashcards'
      ]
    }
  ];

  // Determine current tier
  const currentTierName = subscription?.subscription_tiers?.name || 'Free';

  return (
    <div className="subscription-container">
      {isOnboarding ? (
        <div className="onboarding-header">
          <h1>Choose Your Subscription Plan</h1>
          <p>Select a plan that fits your language learning needs. You can change your plan at any time.</p>
        </div>
      ) : (
        <div className="subscription-header">
          <h1>Subscription Plans</h1>
          <p>Upgrade your plan to unlock more language learning features</p>
        </div>
      )}
      
      {successMessage && <div className="subscription-success">{successMessage}</div>}
      {error && <div className="subscription-error">{error}</div>}
      
      <div className="subscription-tiers">
        {hardcodedTiers.map(tier => (
          <div 
            key={tier.id} 
            className={`subscription-tier ${currentTierName === tier.name ? 'current-tier' : ''}`}
          >
            <h2>{tier.name}</h2>
            <p className="tier-price">{tier.displayPrice}</p>
            
            <div className="tier-features">
              {tier.features.map((feature, index) => (
                <div key={index} className="feature-item">
                  <span className="feature-checkmark">✓</span> {feature}
                </div>
              ))}
            </div>
            
            <div className="tier-button-container">
              {isOnboarding ? (
                <button 
                  onClick={() => tier.name === 'Free' ? handleContinueWithFree() : handleSubscribe(tier.priceId, tier.name)}
                  disabled={loading}
                  className="subscribe-button"
                >
                  {tier.name === 'Free' ? 'Continue with Free Plan' : `Select ${tier.name} Plan`}
                </button>
              ) : (
                currentTierName !== tier.name ? (
                  <button 
                    onClick={() => handleSubscribe(tier.priceId, tier.name)}
                    disabled={loading}
                    className="subscribe-button"
                  >
                    {tier.name === 'Free' ? 'Downgrade to Free' : `Upgrade to ${tier.name}`}
                  </button>
                ) : (
                  <div className="current-plan-badge">Current Plan</div>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
} 