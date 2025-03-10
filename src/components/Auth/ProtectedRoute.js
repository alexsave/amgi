import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const useDirectApi = localStorage.getItem('useDirectApi') === 'true';

  if (loading) {
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
    return <Navigate to="/" />;
  }

  return children;
} 