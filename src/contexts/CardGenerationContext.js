import React, { createContext, useContext, useState, useEffect } from 'react';
import { generateCard as apiGenerateCard, regenerateCardPart as apiRegenerateCardPart } from '../network/api';

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

  // Convert data URL back to Blob
  const dataURLtoBlob = (dataurl) => {
    try {
      const arr = dataurl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      
      // Ensure we're dealing with audio data
      if (!mime.startsWith('audio/')) {
        throw new Error('Invalid audio data');
      }

      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const blob = new Blob([u8arr], { type: 'audio/mp3' }); // Force MP3 type
      return blob;
    } catch (err) {
      throw new Error('Failed to convert audio data');
    }
  };

  // Get audio from storage by ID
  const getAudioById = (audioId) => {
    console.log('localStorage functionality moved to archives, audio ID not available:', audioId);
    return null;
  };

  // Helper function to restore audio blobs
  const restoreBlobs = (front_audio_id, back_audio_id) => {
    // Try to restore front audio blob
    if (front_audio_id) {
      const frontUrl = getAudioById(front_audio_id);
      if (frontUrl) {
        setAudioUrls(prev => ({ ...prev, front: frontUrl }));
        setAudioReady(prev => ({ ...prev, front: true }));
        setProgress(prev => ({ ...prev, front: true }));
      }
    }
    
    // Try to restore back audio blob
    if (back_audio_id) {
      const backUrl = getAudioById(back_audio_id);
      if (backUrl) {
        setAudioUrls(prev => ({ ...prev, back: backUrl }));
        setAudioReady(prev => ({ ...prev, back: true }));
        setProgress(prev => ({ ...prev, back: true }));
      }
    }
  };

  // Try to restore blobs on mount
  useEffect(() => {
    if (generatedCard) {
      restoreBlobs(generatedCard.front_audio_id, generatedCard.back_audio_id);
    }
  }, [generatedCard]);

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
      setGeneratedCard(prev => ({ ...prev, back_text: text }));
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