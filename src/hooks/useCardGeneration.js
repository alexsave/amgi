import { useState, useEffect } from 'react';
import { generateCard as apiGenerateCard } from '../network/api';

export function useCardGeneration() {
  console.log('useCardGeneration: Hook initialized');
  const [generatedCard, setGeneratedCard] = useState(() => {
    const saved = sessionStorage.getItem('lastCard');
    console.log('useCardGeneration: Initial generatedCard from sessionStorage:', saved);
    return saved ? JSON.parse(saved) : null;
  });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  const [audioReady, setAudioReady] = useState({ front: false, back: false });
  const [audioUrls, setAudioUrls] = useState(() => {
    const saved = sessionStorage.getItem('lastCardAudio');
    return saved ? JSON.parse(saved) : { front: null, back: null };
  });

  // Store blobs in session storage
  const storeBlob = async (blob, side) => {
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => {
        const base64data = reader.result;
        sessionStorage.setItem(`lastCardBlob_${side}`, base64data);
        resolve();
      };
      reader.readAsDataURL(blob);
    });
  };

  // Restore blobs from session storage
  const restoreBlobs = () => {
    const frontBlob = sessionStorage.getItem('lastCardBlob_front');
    const backBlob = sessionStorage.getItem('lastCardBlob_back');
    if (frontBlob) {
      const frontUrl = URL.createObjectURL(dataURLtoBlob(frontBlob));
      setAudioUrls(prev => ({ ...prev, front: frontUrl }));
    }
    if (backBlob) {
      const backUrl = URL.createObjectURL(dataURLtoBlob(backBlob));
      setAudioUrls(prev => ({ ...prev, back: backUrl }));
    }
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

  // Try to restore blobs on mount
  useEffect(() => {
    restoreBlobs();
  }, []);

  const generateCard = async (userInput, targetLang, blobUrlsRef, frontAudioRef, backAudioRef) => {
    console.log('useCardGeneration: generateCard called with:', {
      userInput,
      targetLang,
      blobUrlsRefs: blobUrlsRef.current,
      frontAudioSrc: frontAudioRef.current.src,
      backAudioSrc: backAudioRef.current.src
    });
    setLoading(true);
    console.log('useCardGeneration: Resetting states');
    setGeneratedCard(null);
    setAudioReady({ front: false, back: false });
    setAudioUrls({ front: null, back: null });
    sessionStorage.removeItem('lastCardAudio');
    sessionStorage.removeItem('lastCard');
    sessionStorage.removeItem('lastCardBlob_front');
    sessionStorage.removeItem('lastCardBlob_back');
    setProgress({ text: false, front: false, back: false });

    try {
      const handleProgress = (data) => {
        console.log('useCardGeneration: Progress update received:', data);
        if (data.type === 'card') {
          console.log('useCardGeneration: Setting card data:', data.data);
          const cardData = data.data;
          console.log('useCardGeneration: About to call setGeneratedCard with:', cardData);
          setGeneratedCard(cardData);
          console.log('useCardGeneration: Called setGeneratedCard');
          sessionStorage.setItem('lastCard', JSON.stringify(cardData));
          console.log('useCardGeneration: Saved card to sessionStorage');
          setProgress(prev => {
            console.log('useCardGeneration: Updating progress - text complete');
            return { ...prev, text: true };
          });
        } else if (data.type === 'audio') {
          console.log(`useCardGeneration: Setting ${data.side} audio:`, data.url);
          if (data.side === 'front') {
            console.log('useCardGeneration: Updating front audio refs and state');
            frontAudioRef.current.src = data.url;
            blobUrlsRef.current.front = data.url;
            setAudioUrls(prev => {
              const newUrls = { ...prev, front: data.url };
              console.log('useCardGeneration: New audio URLs state:', newUrls);
              sessionStorage.setItem('lastCardAudio', JSON.stringify(newUrls));
              return newUrls;
            });
            // Store the blob
            fetch(data.url)
              .then(r => r.blob())
              .then(blob => {
                console.log('useCardGeneration: Stored front audio blob');
                return storeBlob(blob, 'front');
              });
            setAudioReady(prev => ({ ...prev, front: true }));
          } else {
            console.log('useCardGeneration: Updating back audio refs and state');
            backAudioRef.current.src = data.url;
            blobUrlsRef.current.back = data.url;
            setAudioUrls(prev => {
              const newUrls = { ...prev, back: data.url };
              console.log('useCardGeneration: New audio URLs state:', newUrls);
              sessionStorage.setItem('lastCardAudio', JSON.stringify(newUrls));
              return newUrls;
            });
            // Store the blob
            fetch(data.url)
              .then(r => r.blob())
              .then(blob => {
                console.log('useCardGeneration: Stored back audio blob');
                return storeBlob(blob, 'back');
              });
            setAudioReady(prev => ({ ...prev, back: true }));
          }
          setProgress(prev => {
            console.log(`useCardGeneration: Updating progress - ${data.side} audio complete`);
            return { ...prev, [data.side]: true };
          });
        }
      };

      console.log('useCardGeneration: Calling API generateCard');
      await apiGenerateCard(userInput, targetLang, handleProgress);
      console.log('useCardGeneration: API call completed successfully');
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