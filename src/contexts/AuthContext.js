import { createClient } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { clearApiInstance } from '../network/api';

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_KEY
);

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isDirectMode, setIsDirectMode] = useState(false);

  useEffect(() => {
    // Check if direct mode is enabled
    const directMode = localStorage.getItem('useDirectApi') === 'true';
    setIsDirectMode(directMode);

    // Check active sessions and sets the user
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for changes on auth state (sign in, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });
    if (error) throw error;
    return data;
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  };

  const signOut = async () => {
    if (isDirectMode) {
      localStorage.removeItem('useDirectApi');
      localStorage.removeItem('OPENAI_KEY');
      clearApiInstance();
      setIsDirectMode(false);
    } else {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    }
  };

  const resetPassword = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  };

  const updatePassword = async (newPassword) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (error) throw error;
  };

  const enableDirectMode = (apiKey) => {
    if (!apiKey?.trim()) {
      throw new Error('API key is required');
    }
    localStorage.setItem('useDirectApi', 'true');
    localStorage.setItem('OPENAI_KEY', apiKey.trim());
    setIsDirectMode(true);
  };

  const disableDirectMode = () => {
    localStorage.removeItem('useDirectApi');
    localStorage.removeItem('OPENAI_KEY');
    clearApiInstance();
    setIsDirectMode(false);
  };

  return (
    <AuthContext.Provider value={{
      user,
      isDirectMode,
      enableDirectMode,
      disableDirectMode,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      loading
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
}; 