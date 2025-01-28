import { useCallback } from 'react';
import { evaluateSpeech as apiEvaluateSpeech } from '../network/api';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = useCallback(async (recordedBlob, currentCard) => {
    try {
      // Get the expected audio data
      const backAudioResponse = await fetch(audio.backAudioRef.current.src);
      const backAudioBlob = await backAudioResponse.blob();
      
      const result = await apiEvaluateSpeech(
        recordedBlob,
        currentCard.backText,
        currentCard.targetLang,
        backAudioBlob
      );
      
      onEvaluationResult(result);
    } catch (err) {
      console.error('Error evaluating speech:', err);
      audio.setError('Failed to evaluate speech: ' + err.message);
    }
  }, [audio, onEvaluationResult]);

  return { evaluateSpeech };
} 