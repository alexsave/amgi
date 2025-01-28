import { useCallback } from 'react';
import { evaluateSpeech as apiEvaluateSpeech } from '../network/api';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = useCallback(async (recordedBlob, currentCard) => {
    try {
      console.log('useSpeechEvaluation: Starting evaluation with card:', {
        backText: currentCard.backText,
        frontLang: currentCard.frontLang,
        backLang: currentCard.backLang,
        hasRecordedBlob: !!recordedBlob,
        recordedBlobSize: recordedBlob?.size,
        backAudioSrc: audio.backAudioRef.current?.src
      });

      if (!currentCard.backLang) {
        throw new Error('Target language (backLang) is required for speech evaluation');
      }

      // Get the expected audio data
      const backAudioResponse = await fetch(audio.backAudioRef.current.src);
      const backAudioBlob = await backAudioResponse.blob();
      console.log('useSpeechEvaluation: Got expected audio blob:', {
        size: backAudioBlob.size,
        type: backAudioBlob.type
      });
      
      console.log('useSpeechEvaluation: Calling API with params:', {
        recordedBlobSize: recordedBlob.size,
        backText: currentCard.backText,
        backLang: currentCard.backLang,
        backAudioBlobSize: backAudioBlob.size
      });

      const result = await apiEvaluateSpeech(
        recordedBlob,
        currentCard.backText,
        currentCard.backLang, // Using backLang as the target language for evaluation
        backAudioBlob
      );
      
      console.log('useSpeechEvaluation: Received evaluation result:', {
        result: result.result,
        messageLength: result.message?.length,
        hasAudio: !!result.audio
      });

      onEvaluationResult(result);
    } catch (err) {
      console.error('Error evaluating speech:', err);
      audio.setError('Failed to evaluate speech: ' + err.message);
    }
  }, [audio, onEvaluationResult]);

  return { evaluateSpeech };
} 