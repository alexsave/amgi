import { useState, useEffect } from 'react';
import { generateCard as apiGenerateCard } from '../network/api';
import { saveAudio, loadAudio } from '../db/localStorage';

export function useCardGeneration() {
  const [generatedCard, setGeneratedCard] = useState(() => {
    return null;
  });
  
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [audioUrls, setAudioUrls] = useState(() => {
    return { front: null, back: null };
  });

  // Log state changes
  useEffect(() => {
  }, [generatedCard]);

  useEffect(() => {
  }, [audioUrls]);

  useEffect(() => {
  }, [loading]);

  useEffect(() => {
  }, [progress]);

  useEffect(() => {
  }, [audioReady]);

  // Store blobs in session storage
  const storeBlob = async (blob, side) => {
    // Only store if we don't already have an ID for this side
    if (side === 'front' && generatedCard?.frontAudioId) {
      return generatedCard.frontAudioId;
    }
    if (side === 'back' && generatedCard?.backAudioId) {
      return generatedCard.backAudioId;
    }
    return saveAudio(blob, blob.type);
  };

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
    const audioData = loadAudio(audioId);
    if (!audioData) {
      return null;
    }
    
    try {
      const blob = dataURLtoBlob(audioData.data);
      const url = URL.createObjectURL(blob);
      return url;
    } catch (err) {
      return null;
    }
  };

  // Restore blobs from storage using IDs
  const restoreBlobs = (frontAudioId, backAudioId) => {
    
    if (frontAudioId) {
      const frontUrl = getAudioById(frontAudioId);
      if (frontUrl) {
        setAudioUrls(prev => ({
          ...prev,
          front: frontUrl
        }));
      }
    }
    
    if (backAudioId) {
      const backUrl = getAudioById(backAudioId);
      if (backUrl) {
        setAudioUrls(prev => ({
          ...prev,
          back: backUrl
        }));
      }
    }
  };

  // Try to restore blobs on mount
  useEffect(() => {
    restoreBlobs(generatedCard?.frontAudioId, generatedCard?.backAudioId);
  }, [generatedCard]);

  const generateCard = async (userInput, targetLang, blobUrlsRef, frontAudioRef, backAudioRef) => {
    setLoading(true);
    setGeneratedCard(null);
    setAudioReady({ front: false, back: false });
    setAudioUrls({ front: null, back: null });
    setProgress({ text: false, front: false, back: false });

    try {
      const handleProgress = (data) => {
        if (data.type === 'text') {
          setGeneratedCard(data.data);
          setProgress(prev => ({ ...prev, text: true }));
        } else if (data.type === 'audio') {
          const side = data.side;
          const audioRef = side === 'front' ? frontAudioRef.current : backAudioRef.current;
          
          // Set audio source and update state
          audioRef.src = data.url;
          blobUrlsRef.current[side] = data.url;
          setAudioUrls(prev => ({ ...prev, [side]: data.url }));
          setAudioReady(prev => ({ ...prev, [side]: true }));
          setProgress(prev => ({ ...prev, [side]: true }));

          // Store audio blob only once
          fetch(data.url)
            .then(r => r.blob())
            .then(async blob => {
              const audioId = await storeBlob(blob, side);
              if (audioId) {
                setGeneratedCard(prev => ({
                  ...prev,
                  [`${side}AudioId`]: audioId
                }));
              }
            });
        }
      };

      await apiGenerateCard(userInput, targetLang, handleProgress);
    } catch (err) {
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return {
    generatedCard,
    loading,
    progress,
    audioReady,
    audioUrls,
    generateCard,
    setGeneratedCard,
    setAudioReady
  };
} 