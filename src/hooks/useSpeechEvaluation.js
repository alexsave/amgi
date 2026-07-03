import { evaluateSpeech as apiEvaluateSpeech } from '../network/supabaseApi';

export function useSpeechEvaluation({ audio, onEvaluationResult }) {
  const evaluateSpeech = async (recordedBlob, card) => {
    try {
      if (!card) {
        throw new Error('No card provided for evaluation');
      }

      // Fall back to deck languages when a card predates the lang columns.
      const frontLang = card.front_lang || card.deck?.known_language || 'en';
      const backLang = card.back_lang || card.deck?.learning_language || 'en';

      if (!card.back_audio_path) {
        throw new Error('No back audio available for comparison');
      }

      const recordedMp3Blob = new Blob([recordedBlob], { type: 'audio/mp3' });

      // The edge function loads the reference audio from storage itself;
      // we only send the user's recording and the storage path.
      const result = await apiEvaluateSpeech(
        recordedMp3Blob,
        card.back_text,
        backLang,
        card.back_audio_path,
        frontLang
      );

      if (!result) {
        throw new Error('No result received from speech evaluation');
      }

      onEvaluationResult(result);
    } catch (err) {
      console.error('Speech evaluation error:', err);
      audio.setError(err.message);
      throw err;
    }
  };

  return { evaluateSpeech };
}
