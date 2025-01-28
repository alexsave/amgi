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
    console.log('useCardGeneration: generatedCard changed:', generatedCard);
  }, [generatedCard]);

  useEffect(() => {
    console.log('useCardGeneration: audioUrls changed:', audioUrls);
  }, [audioUrls]);

  useEffect(() => {
    console.log('useCardGeneration: loading changed:', loading);
  }, [loading]);

  useEffect(() => {
    console.log('useCardGeneration: progress changed:', progress);
  }, [progress]);

  useEffect(() => {
    console.log('useCardGeneration: audioReady changed:', audioReady);
  }, [audioReady]);

  // Store blobs in session storage
  const storeBlob = async (blob, side) => {
    console.log(`useCardGeneration: Storing blob for ${side}`, { blobSize: blob.size });
    return saveAudio(blob, blob.type);
  };

  // Get audio from storage by ID
  const getAudioById = (audioId) => {
    const audioData = loadAudio(audioId);
    if (!audioData) return null;
    
    const blob = dataURLtoBlob(audioData.data);
    return URL.createObjectURL(blob);
  };

  // Convert data URL back to Blob
  const dataURLtoBlob = (dataurl) => {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  };

  // Restore blobs from storage using IDs
  const restoreBlobs = (frontAudioId, backAudioId) => {
    console.log('useCardGeneration: Attempting to restore blobs with IDs:', { frontAudioId, backAudioId });
    
    if (frontAudioId) {
      const frontUrl = getAudioById(frontAudioId);
      if (frontUrl) {
        console.log('useCardGeneration: Restored front audio URL:', frontUrl);
        setAudioUrls(prev => ({
          ...prev,
          front: frontUrl
        }));
      }
    }
    
    if (backAudioId) {
      const backUrl = getAudioById(backAudioId);
      if (backUrl) {
        console.log('useCardGeneration: Restored back audio URL:', backUrl);
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
    console.log('useCardGeneration: generateCard called with:', {
      userInput,
      targetLang,
      blobUrlsRefs: blobUrlsRef.current,
      frontAudioSrc: frontAudioRef.current.src,
      backAudioSrc: backAudioRef.current.src
    });

    setLoading(true);
    console.log('useCardGeneration: Set loading to true');

    console.log('useCardGeneration: Resetting states');
    setGeneratedCard(null);
    setAudioReady({ front: false, back: false });
    setAudioUrls({ front: null, back: null });
    setProgress({ text: false, front: false, back: false });
    console.log('useCardGeneration: All states reset');

    try {
      const handleProgress = (data) => {
        console.log('useCardGeneration: Progress update received:', JSON.stringify(data));
        
        if (data.type === 'text') {
          console.log('useCardGeneration: Handling card data:', data.data);
          const cardData = data.data;
          console.log('useCardGeneration: About to call setGeneratedCard with:', cardData);
          setGeneratedCard(cardData);
          setProgress(prev => {
            const newProgress = { ...prev, text: true };
            console.log('useCardGeneration: Updated progress:', newProgress);
            return newProgress;
          });
        } else if (data.type === 'audio') {
          console.log(`useCardGeneration: Handling ${data.side} audio:`, data.url);
          if (data.side === 'front') {
            console.log('useCardGeneration: Setting front audio');
            frontAudioRef.current.src = data.url;
            blobUrlsRef.current.front = data.url;
            setAudioUrls(prev => {
              const newUrls = { ...prev, front: data.url };
              console.log('useCardGeneration: New audioUrls state:', newUrls);
              return newUrls;
            });
            setAudioReady(prev => {
              const newReady = { ...prev, front: true };
              console.log('useCardGeneration: Updated audioReady:', newReady);
              return newReady;
            });
            // Handle storage asynchronously
            fetch(data.url)
              .then(r => r.blob())
              .then(async blob => {
                console.log('useCardGeneration: Got front audio blob:', { size: blob.size });
                const audioId = await storeBlob(blob, 'front');
                setGeneratedCard(prev => ({
                  ...prev,
                  frontAudioId: audioId
                }));
              });
          } else if (data.side === 'back') {
            console.log('useCardGeneration: Setting back audio');
            backAudioRef.current.src = data.url;
            blobUrlsRef.current.back = data.url;
            setAudioUrls(prev => {
              const newUrls = { ...prev, back: data.url };
              console.log('useCardGeneration: New audioUrls state:', newUrls);
              return newUrls;
            });
            setAudioReady(prev => {
              const newReady = { ...prev, back: true };
              console.log('useCardGeneration: Updated audioReady:', newReady);
              return newReady;
            });
            // Handle storage asynchronously
            fetch(data.url)
              .then(r => r.blob())
              .then(async blob => {
                console.log('useCardGeneration: Got back audio blob:', { size: blob.size });
                const audioId = await storeBlob(blob, 'back');
                setGeneratedCard(prev => ({
                  ...prev,
                  backAudioId: audioId
                }));
              });
          }
          setProgress(prev => {
            const newProgress = { ...prev, [data.side]: true };
            console.log(`useCardGeneration: Updated progress for ${data.side}:`, newProgress);
            return newProgress;
          });
        }
      };

      console.log('useCardGeneration: Calling API generateCard');
      const result = await apiGenerateCard(userInput, targetLang, handleProgress);
      console.log('useCardGeneration: API call completed with result:', result);
    } catch (err) {
      console.error('useCardGeneration: Error in generateCard:', err);
      throw err;
    } finally {
      console.log('useCardGeneration: Setting loading to false');
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