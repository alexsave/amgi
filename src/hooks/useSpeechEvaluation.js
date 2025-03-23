import { evaluateSpeech as apiEvaluateSpeech } from '../network/api';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = async (recordedBlob, card) => {
    try {

      // Get the expected audio from storage
      if (!card.back_audio_path) {
        throw new Error('No back audio ID available for comparison');
      }

      // I now realize we could just pass the path to the edge function and not load it here
      // Load the expected audio from storage
      await audio.loadAudio(card.back_audio_path);
      
      // Get the audio URL from the ref
      const backAudioUrl = audio.audioRefs.current.get(card.back_audio_path).src;

      // Fetch the audio data
      const audioResponse = await fetch(backAudioUrl);

      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch expected audio: ${audioResponse.status}`);
      }

      const contentType = audioResponse.headers.get('content-type');
      if (!contentType?.includes('audio/')) {
        console.error('Received non-audio content type:', contentType);
        throw new Error('Expected audio file but received different content type');
      }

      const backAudioBlob = await audioResponse.blob();


      // Create MP3 blobs for both recorded and expected audio
      const recordedMp3Blob = new Blob([recordedBlob], { type: 'audio/mp3' });
      const backAudioMp3Blob = new Blob([backAudioBlob], { type: 'audio/mp3' });

      // Call the API using the proper implementation
      const result = await apiEvaluateSpeech(
        recordedMp3Blob,      // audio_blob
        card.back_text,       // expected_text
        card.back_lang,       // back_lang (the language of the text being spoken)
        backAudioMp3Blob,     // expected_audio_blob
        card.front_lang       // front_lang (the language the user knows)
      );


      if (!result) {
        throw new Error('No result received from speech evaluation');
      }

      onEvaluationResult(result);
    } catch (err) {
      audio.setError(err.message);
      throw err;
    }
  };

  return { evaluateSpeech };
} 