import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import supabase from '../db/supabaseClient';
import { loadStripe } from '@stripe/stripe-js';
import { useNavigate, useLocation } from 'react-router-dom';
import './SubscriptionPage.css';

// Initialize Stripe
const stripePromise = loadStripe(process.env.REACT_APP_STRIPE_PUBLIC_KEY);

export default function SubscriptionPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState(null);
  const [tiers, setTiers] = useState([]);
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
    console.log('SubscriptionPage mounted. User:', user?.id);
    
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
    console.log('User changed in SubscriptionPage:', user?.id);
    if (user) {
      loadSubscriptionData();
    } else {
      console.warn('No user available in SubscriptionPage');
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
      
      // Load subscription tiers
      const { data: tiersData, error: tiersError } = await supabase
        .from('subscription_tiers')
        .select('*')
        .order('realtime_minutes_limit', { ascending: true });
        
      if (tiersError) {
        console.error('Error loading tiers:', tiersError);
        throw tiersError;
      }
      
      console.log('Loaded subscription tiers:', tiersData);
      
      // Update tier prices for display
      const updatedTiers = tiersData.map(tier => ({
        ...tier,
        displayPrice: tier.name === 'Free' ? 'Free' : 
                     tier.name === 'Standard' ? '$30/month' : 
                     tier.name === 'Pro' ? '$100/month' : ''
      }));
      
      setTiers(updatedTiers);
      
      // Load user's current subscription
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
      if (tierName === 'Free' && isOnboarding && subscription?.tier_id === tiers[0]?.id) {
        navigate('/');
        return;
      }
      
      // Call server function to create checkout session
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: {
          priceId,
          customerId: subscription?.stripe_customer_id,
          userId: user.id,
          tierName
        }
      });
      
      if (error) throw error;
      
      // Handle free tier - might return redirectUrl instead of sessionId
      if (data.redirectUrl) {
        navigate('/');
        return;
      }
      
      // Redirect to Stripe checkout
      const stripe = await stripePromise;
      const { error: stripeError } = await stripe.redirectToCheckout({
        sessionId: data.sessionId
      });
      
      if (stripeError) throw stripeError;
      
    } catch (err) {
      setError('Failed to process subscription: ' + err.message);
      setLoading(false);
    }
  }

  function handleContinueWithFree() {
    navigate('/');
  }

  if (loading) return <div className="subscription-container">Loading...</div>;

  return (
    <div className="subscription-container">
      {isOnboarding ? (
        <div className="onboarding-header">
          <h1>Choose Your Subscription Plan</h1>
          <p>Select a plan that fits your language learning needs. You can change your plan at any time.</p>
        </div>
      ) : (
        <h1>Subscription Plans</h1>
      )}
      
      {successMessage && <div className="subscription-success">{successMessage}</div>}
      {error && <div className="subscription-error">{error}</div>}
      
      <div className="subscription-tiers">
        {tiers.map(tier => (
          <div key={tier.id} className={`subscription-tier ${subscription?.tier_id === tier.id ? 'current-tier' : ''}`}>
            <h2>{tier.name}</h2>
            <p className="tier-price">{tier.displayPrice}</p>
            
            <div className="tier-features">
              <p>
                {tier.realtime_minutes_limit === -1 ? 
                  'Unlimited live practice sessions' : 
                  `${tier.realtime_minutes_limit} minutes of live practice per month`}
              </p>
              <p>
                {tier.voice_evaluations_limit === -1 ?
                  'Unlimited pronunciation evaluations' :
                  `${tier.voice_evaluations_limit} pronunciation evaluations per month`}
              </p>
              <p>
                {tier.card_audio_generations_limit === -1 ?
                  'Unlimited audio generation for cards' :
                  `${tier.card_audio_generations_limit} audio generations per month`}
              </p>
            </div>
            
            {isOnboarding ? (
              <button 
                onClick={() => tier.name === 'Free' ? handleContinueWithFree() : handleSubscribe(tier.stripe_price_id, tier.name)}
                disabled={loading}
                className="subscribe-button"
              >
                {tier.name === 'Free' ? 'Continue with Free Plan' : `Select ${tier.name} Plan`}
              </button>
            ) : (
              subscription?.tier_id !== tier.id ? (
                <button 
                  onClick={() => handleSubscribe(tier.stripe_price_id, tier.name)}
                  disabled={loading}
                  className="subscribe-button"
                >
                  {tier.name === 'Free' ? 'Downgrade to Free' : `Upgrade to ${tier.name}`}
                </button>
              ) : (
                <div className="current-plan-label">Current Plan</div>
              )
            )}
          </div>
        ))}
      </div>
      
      {!isOnboarding && subscription && subscription.status !== 'canceled' && subscription.tier_id !== tiers[0]?.id && (
        <div className="cancel-subscription">
          <button onClick={() => handleSubscribe(tiers[0].stripe_price_id, 'Free')} className="cancel-button">
            Cancel Subscription
          </button>
          <p>Your subscription will continue until the end of your billing period.</p>
        </div>
      )}
      
      {isOnboarding && (
        <div className="onboarding-actions">
          <button onClick={handleContinueWithFree} className="skip-button">
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
} 