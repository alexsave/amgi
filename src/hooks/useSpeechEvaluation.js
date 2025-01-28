import { useCallback } from 'react';
import { evaluateSpeech as apiEvaluateSpeech } from '../network/api';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = async (recordedBlob, card) => {
    try {
      console.log('useSpeechEvaluation: Starting evaluation with card:', {
        backText: card.backText,
        frontLang: card.frontLang,
        backLang: card.backLang,
        hasRecordedBlob: !!recordedBlob,
        recordedBlobSize: recordedBlob?.size,
        backAudioId: card.backAudioId
      });

      // Get the expected audio from storage
      if (!card.backAudioId) {
        throw new Error('No back audio ID available for comparison');
      }

      // Load the expected audio from storage
      console.log('useSpeechEvaluation: Loading expected audio from storage:', card.backAudioId);
      await audio.loadAudio('back', card.backAudioId);
      
      // Get the audio URL from the ref
      const backAudioUrl = audio.backAudioRef.current.src;
      console.log('useSpeechEvaluation: Fetching expected audio from:', backAudioUrl);

      // Fetch the audio data
      const audioResponse = await fetch(backAudioUrl);
      console.log('useSpeechEvaluation: Fetch response:', {
        ok: audioResponse.ok,
        status: audioResponse.status,
        contentType: audioResponse.headers.get('content-type'),
        contentLength: audioResponse.headers.get('content-length')
      });

      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch expected audio: ${audioResponse.status}`);
      }

      const contentType = audioResponse.headers.get('content-type');
      if (!contentType?.includes('audio/')) {
        console.error('Received non-audio content type:', contentType);
        throw new Error('Expected audio file but received different content type');
      }

      const backAudioBlob = await audioResponse.blob();
      console.log('useSpeechEvaluation: Got expected audio blob:', {
        size: backAudioBlob.size,
        type: backAudioBlob.type
      });

      // Create MP3 blobs for both recorded and expected audio
      const recordedMp3Blob = new Blob([recordedBlob], { type: 'audio/mp3' });
      const backAudioMp3Blob = new Blob([backAudioBlob], { type: 'audio/mp3' });

      console.log('useSpeechEvaluation: Created MP3 blobs:', {
        recorded: {
          size: recordedMp3Blob.size,
          type: recordedMp3Blob.type,
          originalSize: recordedBlob.size,
          originalType: recordedBlob.type
        },
        expected: {
          size: backAudioMp3Blob.size,
          type: backAudioMp3Blob.type,
          originalSize: backAudioBlob.size,
          originalType: backAudioBlob.type
        }
      });

      // Call the API using the proper implementation
      const result = await apiEvaluateSpeech(
        recordedMp3Blob,      // audioBlob
        card.backText,        // expectedText
        card.backLang,        // sourceLang (the language being spoken)
        backAudioMp3Blob      // expectedAudioBlob
      );

      onEvaluationResult(result);
    } catch (err) {
      console.error('Error evaluating speech:', err);
      audio.setError(err.message);
      throw err;
    }
  };

  return { evaluateSpeech };
} 