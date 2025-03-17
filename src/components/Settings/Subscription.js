import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './Subscription.css';

const Subscription = () => {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSubscriptionData = async () => {
      try {
        const [subResponse, usageResponse] = await Promise.all([
          fetch('/api/subscriptions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${user.token}`
            },
            body: JSON.stringify({ action: 'get_subscription' })
          }),
          fetch('/api/subscriptions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${user.token}`
            },
            body: JSON.stringify({ action: 'get_usage' })
          })
        ]);

        const [subData, usageData] = await Promise.all([
          subResponse.json(),
          usageResponse.json()
        ]);

        if (!subResponse.ok) throw new Error(subData.error);
        if (!usageResponse.ok) throw new Error(usageData.error);

        setSubscription(subData.subscription);
        setUsage(usageData.usage);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchSubscriptionData();
    }
  }, [user]);

  const handleUpgrade = async (priceId) => {
    try {
      const response = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          action: 'create_checkout_session',
          priceId
        })
      });

      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <div className="subscription-loading">Loading subscription details...</div>;
  if (error) return <div className="subscription-error">Error: {error}</div>;

  return (
    <div className="subscription-container">
      <h2>Your Subscription</h2>
      
      <div className="current-plan">
        <h3>Current Plan: {subscription?.subscription_tiers?.name || 'Free'}</h3>
        <div className="usage-stats">
          <div className="usage-item">
            <h4>Realtime Sessions</h4>
            <div className="usage-bar">
              <div 
                className="usage-progress" 
                style={{ 
                  width: `${(usage?.realtime_sessions_started / subscription?.subscription_tiers?.realtime_sessions_limit) * 100}%`
                }}
              />
            </div>
            <p>{usage?.realtime_sessions_started || 0} / {subscription?.subscription_tiers?.realtime_sessions_limit === -1 ? 'Unlimited' : subscription?.subscription_tiers?.realtime_sessions_limit}</p>
          </div>
          
          <div className="usage-item">
            <h4>Voice Evaluations</h4>
            <div className="usage-bar">
              <div 
                className="usage-progress" 
                style={{ 
                  width: `${(usage?.voice_evaluations_used / subscription?.subscription_tiers?.voice_evaluations_limit) * 100}%`
                }}
              />
            </div>
            <p>{usage?.voice_evaluations_used || 0} / {subscription?.subscription_tiers?.voice_evaluations_limit === -1 ? 'Unlimited' : subscription?.subscription_tiers?.voice_evaluations_limit}</p>
          </div>
        </div>
      </div>

      <div className="subscription-tiers">
        <div className="tier-card">
          <h3>Free</h3>
          <p className="price">$0/month</p>
          <ul>
            <li>5 realtime sessions/month</li>
            <li>100 voice evaluations/month</li>
          </ul>
          {subscription?.subscription_tiers?.name !== 'Free' && (
            <button 
              onClick={() => handleUpgrade('price_free')}
              className="downgrade-button"
            >
              Downgrade to Free
            </button>
          )}
        </div>

        <div className="tier-card">
          <h3>Standard</h3>
          <p className="price">$19/month</p>
          <ul>
            <li>60 realtime sessions/month</li>
            <li>1000 voice evaluations/month</li>
          </ul>
          {subscription?.subscription_tiers?.name !== 'Standard' && (
            <button 
              onClick={() => handleUpgrade('price_standard_monthly')}
              className="upgrade-button"
            >
              {subscription?.subscription_tiers?.name === 'Pro' ? 'Downgrade to Standard' : 'Upgrade to Standard'}
            </button>
          )}
        </div>

        <div className="tier-card featured">
          <h3>Pro</h3>
          <p className="price">$99/month</p>
          <ul>
            <li>Unlimited realtime sessions</li>
            <li>Unlimited voice evaluations</li>
          </ul>
          {subscription?.subscription_tiers?.name !== 'Pro' && (
            <button 
              onClick={() => handleUpgrade('price_pro_monthly')}
              className="upgrade-button"
            >
              Upgrade to Pro
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Subscription; 