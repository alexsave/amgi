import { evaluateSpeech as apiEvaluateSpeech } from '../network/supabaseApi';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = async (recordedBlob, card) => {
    try {
      // Validate card and required properties
      if (!card) {
        throw new Error('No card provided for evaluation');
      }

      console.log("Starting speech evaluation with card:", {
        id: card.id,
        front_text: card.front_text, 
        back_text: card.back_text,
        front_lang: card.front_lang,
        back_lang: card.back_lang
      });

      // Validate required language fields
      if (!card.back_lang) {
        throw new Error('Missing back_lang (target language) on card');
      }
      
      if (!card.front_lang) {
        throw new Error('Missing front_lang (source language) on card');
      }

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

      console.log("Calling API with params:", {
        text_length: card.back_text?.length || 0,
        back_lang: card.back_lang,
        front_lang: card.front_lang
      });

      // Call the API using the proper implementation
      const result = await apiEvaluateSpeech(
        recordedMp3Blob,              // audio_blob
        card.back_text,               // expected_text
        card.back_lang || 'en',       // back_lang (the language of the text being spoken) - default to English if missing
        backAudioMp3Blob,             // expected_audio_blob
        card.front_lang || 'en'       // front_lang (the language the user knows) - default to English if missing
      );

      if (!result) {
        throw new Error('No result received from speech evaluation');
      }

      onEvaluationResult(result);
    } catch (err) {
      console.error("Speech evaluation error:", err);
      audio.setError(err.message);
      throw err;
    }
  };

  return { evaluateSpeech };
} 