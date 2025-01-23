import { useState } from 'react';

export function useCardGeneration() {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ text: false, front: false, back: false });
  const [audioReady, setAudioReady] = useState({ front: false, back: false });

  const generateCard = async (userInput, targetLang, blobUrlsRef, frontAudioRef, backAudioRef) => {
    console.log('Starting card generation...');
    setLoading(true);
    setCard(null);
    setAudioReady({ front: false, back: false });
    setProgress({ text: false, front: false, back: false });

    try {
      console.log('Sending request to server...');
      const response = await fetch('http://localhost:8000/api/generate_cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userInput,
          targetLang,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Server returned error:', errorData);
        throw new Error(errorData.error || 'Failed to generate card');
      }

      console.log('Starting to read stream...');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('Stream complete');
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            console.log('Processing data type:', data.type);
            
            if (data.type === 'card') {
              console.log('Setting card data:', data.data);
              setCard(data.data);
              setProgress(prev => ({ ...prev, text: true }));
            } else if (data.type === 'audio') {
              console.log(`Processing ${data.side} audio, size:`, data.data.length);
              
              const audioData = new Uint8Array(data.data);
              const blob = new Blob([audioData], { type: 'audio/mpeg' });
              const url = URL.createObjectURL(blob);
              
              if (data.side === 'front') {
                console.log('Setting front audio with URL:', url);
                frontAudioRef.current.src = url;
                blobUrlsRef.current.front = url;
                setAudioReady(prev => ({ ...prev, front: true }));
              } else {
                console.log('Setting back audio with URL:', url);
                backAudioRef.current.src = url;
                blobUrlsRef.current.back = url;
                setAudioReady(prev => ({ ...prev, back: true }));
              }

              setProgress(prev => ({
                ...prev,
                [data.side]: true
              }));

              console.log(`Audio element updated for ${data.side}:`, {
                side: data.side,
                url: url,
                audioSrc: data.side === 'front' ? frontAudioRef.current.src : backAudioRef.current.src
              });
            }
          } catch (e) {
            console.error('Error processing stream chunk:', e);
          }
        }
      }
    } catch (err) {
      console.error('Error in generateCard:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return {
    card,
    loading,
    progress,
    audioReady,
    generateCard,
    setCard,
    setAudioReady
  };
} 