import { useCallback } from 'react';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = useCallback(async (recordedBlob, currentCard) => {
    try {
      // Get the expected audio data
      const backAudioResponse = await fetch(audio.backAudioRef.current.src);
      const backAudioBlob = await backAudioResponse.blob();
      
      // Convert recorded audio to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Audio = reader.result.split(',')[1];
        
        // Convert expected audio to base64
        const backAudioReader = new FileReader();
        backAudioReader.onloadend = async () => {
          const expectedAudioBase64 = backAudioReader.result.split(',')[1];
          
          const response = await fetch('http://localhost:8000/api/evaluate_speech', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              audioBase64: base64Audio,
              expectedText: currentCard.backText,
              sourceLang: currentCard.targetLang,
              expectedAudioBase64: expectedAudioBase64,
              audioFormat: 'mp3'
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error('Failed to evaluate speech: ' + (errorData.error || 'Unknown error'));
          }

          const data = await response.json();
          onEvaluationResult(data);
        };

        backAudioReader.readAsDataURL(backAudioBlob);
      };

      reader.readAsDataURL(recordedBlob);
    } catch (err) {
      console.error('Error evaluating speech:', err);
      audio.setError('Failed to evaluate speech: ' + err.message);
    }
  }, [audio, onEvaluationResult]);

  return { evaluateSpeech };
} 