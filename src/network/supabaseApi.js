// Thin client for the Supabase edge functions.
import supabase from '../db/supabaseClient';
import { blobToBase64 } from './utils';

/**
 * Invokes an edge function and unwraps the standard `{ error }` envelope.
 * `supabase.functions.invoke` only rejects on network-level failures, so
 * non-2xx responses are surfaced here with the server's error message.
 */
const invoke = async (name, body) => {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    // FunctionsHttpError carries the server response; extract its message.
    let message = error.message;
    try {
      const detail = await error.context?.json();
      if (detail?.error) message = detail.error;
    } catch (e) {
      // Response body wasn't JSON — keep the generic message.
    }
    throw new Error(message);
  }

  return data;
};

export const generateCard = async (user_input, known_language, learning_language, onProgress) => {
  const data = await invoke('cards', {
    user_input,
    known_language,
    learning_language
  });

  const cardData = {
    front_text: data.card.front_text,
    back_text: data.card.back_text,
    front_lang: data.card.front_lang || known_language,
    back_lang: data.card.back_lang || learning_language,
    front_audio_path: data.card.front_audio_path,
    back_audio_path: data.card.back_audio_path
  };

  if (typeof onProgress === 'function') {
    onProgress({ type: 'text', data: cardData });
  }

  return cardData;
};

export const regenerateCardPart = async (currentCard, parts = [], known_language, learning_language, onProgress) => {
  const data = await invoke('cards', {
    regenerate_parts: parts, // ['front_text', 'front_audio_path', 'back_text', 'back_audio_path']
    current_card: currentCard,
    known_language,
    learning_language
  });

  const cardData = {
    front_text: data.card.front_text,
    back_text: data.card.back_text,
    front_lang: data.card.front_lang || known_language,
    back_lang: data.card.back_lang || learning_language,
    front_audio_path: data.card.front_audio_path,
    back_audio_path: data.card.back_audio_path
  };

  if (typeof onProgress === 'function') {
    onProgress({ type: 'text', data: cardData });
  }

  return cardData;
};

/**
 * Sends the learner's recording for evaluation. The reference pronunciation
 * is passed as a storage path so the edge function fetches it server-side —
 * the browser never has to download and re-upload it.
 */
export const evaluateSpeech = async (audioBlob, expectedText, backLang, expectedAudioPath, frontLang) => {
  return invoke('speech', {
    audio_base64: await blobToBase64(audioBlob),
    expected_text: expectedText,
    back_lang: backLang,
    expected_audio_path: expectedAudioPath,
    front_lang: frontLang
  });
};

/**
 * Mints a short-lived Realtime client secret for the live conversation mode.
 * Returns `{ client_secret, expires_at, model }`.
 */
export const getRealtimeToken = async () => {
  return invoke('realtime', {});
};
