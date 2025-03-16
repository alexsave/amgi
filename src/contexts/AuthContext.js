import React, { createContext, useContext, useEffect, useState } from 'react';
import { clearApiInstance } from '../network/api';
import supabase from '../db/supabaseClient';

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
      console.log('Initial session check:', session?.user?.id || 'No session');
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for changes on auth state (sign in, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('Auth state changed - Event:', event, 'User ID:', session?.user?.id || 'none');
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email, password) => {
    console.log('Sign up initiated for email:', email);
    
    // Set up the redirect URL for after email verification
    const redirectTo = 'https://www.amgi.cards/subscription';
    
    // Proceed with signup - Supabase handles duplicate email prevention
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectTo
      }
    });
    
    if (error) {
      console.error('Supabase signup error:', error);
      throw error;
    }
    
    console.log('Sign up successful, user data:', data);
    console.log('Email verification will redirect to:', redirectTo);
    return data;
  };

  const signIn = async (email, password) => {
    console.log('Sign in initiated for email:', email);
    
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    
    if (error) {
      console.error('Supabase signin error:', error);
      throw error;
    }
    
    console.log('Sign in successful, user:', data?.user?.id);
    return data;
  };

  const signOut = async () => {
    try {
      console.log('Sign out initiated. Mode:', isDirectMode ? 'Direct' : 'Supabase');
      
      if (isDirectMode) {
        try {
          localStorage.removeItem('useDirectApi');
          console.log('Removed useDirectApi from localStorage');
          
          localStorage.removeItem('OPENAI_KEY');
          console.log('Removed OPENAI_KEY from localStorage');
          
          clearApiInstance();
          console.log('Cleared API instance');
          
          setIsDirectMode(false);
          console.log('Direct mode disabled');
        } catch (localStorageError) {
          console.error('localStorage error during sign out:', localStorageError);
          throw new Error(`LocalStorage error: ${localStorageError.message}`);
        }
      } else {
        console.log('Calling supabase.auth.signOut()');
        const { error } = await supabase.auth.signOut();
        
        if (error) {
          console.error('Supabase signOut error:', error);
          
          // Handle "Auth session missing" error specifically
          if (error.message === 'Auth session missing!' || 
              error.message.includes('session')) {
            console.log('Session missing error detected - performing local sign out');
            // Force a local sign out despite the error
            setUser(null);
            // Clear any session data that might be in localStorage
            try {
              localStorage.removeItem('supabase.auth.token');
              localStorage.removeItem('supabase.auth.expires_at');
              // Any other Supabase session-related items you might have
            } catch (e) {
              console.log('Error clearing local storage:', e);
            }
            console.log('Local sign out completed');
            return; // Exit without throwing error since we've handled it
          }
          
          throw error;
        }
        console.log('Supabase sign out successful');
      }
    } catch (error) {
      console.error('Sign out error:', error);
      throw error;
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