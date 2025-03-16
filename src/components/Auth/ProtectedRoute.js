import React, { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const useDirectApi = localStorage.getItem('useDirectApi') === 'true';
  
  useEffect(() => {
    console.log('ProtectedRoute - Auth state:', { 
      user: user?.id, 
      loading, 
      useDirectApi,
      path: window.location.pathname
    });
  }, [user, loading, useDirectApi]);

  if (loading) {
    console.log('ProtectedRoute - Loading auth state...');
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h2>Loading...</h2>
        </div>
      </div>
    );
  }

  // Allow access if user is authenticated OR using direct API mode
  if (!user && !useDirectApi) {
    console.log('ProtectedRoute - No auth, redirecting to welcome page');
    return <Navigate to="/" />;
  }

  console.log('ProtectedRoute - Auth valid, rendering protected content');
  return children;
} 