import React, { createContext, useContext, useEffect, useState } from 'react';
import supabase from '../db/supabaseClient';

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check active sessions and sets the user
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for changes on auth state (sign in, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email, password, metadata = {}) => {
    
    // Set up the redirect URL for after email verification
    const redirectTo = 'https://www.amgi.cards/subscription';
    
    // Proceed with signup - Supabase handles duplicate email prevention
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          isAdult: metadata.isAdult || false,
          hasAcceptedEULA: metadata.hasAcceptedEULA || false,
          hasAcceptedPrivacy: metadata.hasAcceptedPrivacy || false
        }
      }
    });
    
    if (error) {
      throw error;
    }
    
    return data;
  };

  const signIn = async (email, password) => {
    
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
      console.log('Sign out initiated');
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
          console.log('Local sign out completed');
          return; // Exit without throwing error since we've handled it
        }
        
        throw error;
      }
      console.log('Supabase sign out successful');
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

  const updateUserProfile = async (userMetadata) => {
    try {
      const { data, error } = await supabase.auth.updateUser({
        data: {
          ...user?.user_metadata,
          ...userMetadata
        }
      });
      
      if (error) {
        console.error('Update user profile error:', error);
        throw error;
      }
      
      // Update the local user state with the new metadata
      setUser(data.user);
      return data.user;
    } catch (error) {
      console.error('Error updating user profile:', error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      updateUserProfile,
      loading
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
}; 