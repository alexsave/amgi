import React, { createContext, useContext, useState } from 'react';
import { generateCard as apiGenerateCard, regenerateCardPart as apiRegenerateCardPart } from '../network/supabaseApi';

const CardGenerationContext = createContext();

export const useCardGenerationContext = () => {
  return useContext(CardGenerationContext);
};

export const CardGenerationProvider = ({ children }) => {
  // Card generation form state
  const [user_input, setUserInput] = useState('');
  const [error, setError] = useState(null);
  
  // Generated card state
  const [generatedCard, setGeneratedCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [regeneratingParts, setRegeneratingParts] = useState([]);
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [audioUrls, setAudioUrls] = useState({ front: null, back: null });

  const clearGeneratedCard = () => {
    setGeneratedCard(null);
  };

  const clearInput = () => {
    setUserInput('');
    setError(null);
  };

  const generateCard = async (input, known_language, learning_language) => {
    if (!input.trim()) {
      setError('Please enter some text');
      return null;
    }
    
    setError(null);
    setLoading(true);
    setGeneratedCard(null);
    setAudioReady({ front: false, back: false });
    setAudioUrls({ front: null, back: null });
    setProgress({ text: false, front: false, back: false });

    try {
      console.log('CardGenerationContext: Generating card with', {
        input,
        known_language,
        learning_language
      });

      let receivedCardData = null;

      const handleProgress = (data) => {
        console.log('CardGenerationContext: handleProgress', data);
        if (data.type === 'text') {
          // Important: Save the generated card data to state
          const cardData = data.data;
          setGeneratedCard(cardData);
          setProgress(prev => ({ ...prev, text: true }));
          receivedCardData = cardData; // Store locally as well
        }
      };

      // Call the API to generate the card
      const apiResult = await apiGenerateCard(input, known_language, learning_language, handleProgress);
      
      // CRITICAL: If the callback didn't set our state (in some API implementations), use the return value
      if (!receivedCardData && apiResult) {
        console.log('CardGenerationContext: Setting generated card from apiResult', apiResult);
        setGeneratedCard(apiResult);
        receivedCardData = apiResult;
      }
      
      setLoading(false);
      return receivedCardData; // Return the data received for immediate use
    } catch (err) {
      console.error('CardGenerationContext: Error in generateCard:', err);
      setError(err.message);
      setLoading(false);
      return null;
    }
  };

  const regenerateCardPart = async (parts = [], known_language, learning_language) => {
    if (!generatedCard) {
      setError('No card data to regenerate');
      return null;
    }
    
    setError(null);
    setLoading(true);
    setRegeneratingParts(parts);
    
    // Reset progress only for the parts being regenerated
    const newProgress = { ...progress };
    if (parts.includes('front_text') || parts.includes('front_audio_path')) {
      newProgress.front = false;
      setAudioReady(prev => ({ ...prev, front: false }));
      setAudioUrls(prev => ({ ...prev, front: null }));
    }
    if (parts.includes('back_text') || parts.includes('back_audio_path')) {
      newProgress.back = false;
      setAudioReady(prev => ({ ...prev, back: false }));
      setAudioUrls(prev => ({ ...prev, back: null }));
    }
    if (parts.includes('front_text') || parts.includes('back_text')) {
      newProgress.text = false;
    }
    setProgress(newProgress);

    try {
      console.log('CardGenerationContext: Regenerating card parts', {
        parts,
        known_language,
        learning_language
      });

      let receivedCardData = null;

      const handleProgress = (data) => {
        console.log('CardGenerationContext: handleProgress', data);
        if (data.type === 'text') {
          // Important: Save the generated card data to state
          const cardData = data.data;
          setGeneratedCard(cardData);
          setProgress(prev => ({ ...prev, text: true }));
          receivedCardData = cardData; // Store locally as well
        }
      };

      // Call the API to regenerate the specified parts
      const apiResult = await apiRegenerateCardPart(
        generatedCard, 
        parts, 
        known_language, 
        learning_language, 
        handleProgress
      );
      
      // CRITICAL: If the callback didn't set our state (in some API implementations), use the return value
      if (!receivedCardData && apiResult) {
        console.log('CardGenerationContext: Setting regenerated card from apiResult', apiResult);
        setGeneratedCard(apiResult);
        receivedCardData = apiResult;
      }
      
      setLoading(false);
      setRegeneratingParts([]);
      return receivedCardData; // Return the data received for immediate use
    } catch (err) {
      console.error('CardGenerationContext: Error in regenerateCardPart:', err);
      setError(err.message);
      setLoading(false);
      setRegeneratingParts([]);
      return null;
    }
  };

  const updateCardText = (part, text) => {
    if (!generatedCard) return;
    
    if (part === 'front_text') {
      setGeneratedCard(prev => ({ ...prev, front_text: text }));
    } else if (part === 'back_text') {
      // The reading describes the text the server generated. Once the learner
      // edits that text it describes nothing, and audio regenerated against a
      // stale reading would be checked for the wrong pronunciation.
      setGeneratedCard(prev => ({ ...prev, back_text: text, spoken_reading: '' }));
    }
  };

  const value = {
    // Form state
    user_input,
    setUserInput,
    error,
    setError,
    
    // Card generation state and functions
    generatedCard,
    setGeneratedCard,
    isGenerating: loading,
    regeneratingParts,
    progress,
    audioReady,
    audioUrls,
    
    // Helper functions
    clearGeneratedCard,
    clearInput,
    generateCard,
    regenerateCardPart,
    updateCardText
  };

  return (
    <CardGenerationContext.Provider value={value}>
      {children}
    </CardGenerationContext.Provider>
  );
}; 