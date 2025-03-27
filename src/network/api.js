// Network API operations
import supabaseClient from '../db/supabaseClient';
import { blobToBase64 } from './utils';

// API instance management
export class SupabaseApi {
  constructor() {
    this.supabase = supabaseClient;
  }

  async getHeaders() {
    const { data: { session }, error } = await this.supabase.auth.getSession();
    if (error) throw error;

    return {
      'Authorization': `Bearer ${session?.access_token}`,
      'Content-Type': 'application/json',
    };
  }

  async generateCard(user_input, known_language, learning_language, onProgress) {
    try {
      // Call Supabase function to generate the card
      const { data, error } = await this.supabase.functions.invoke('cards', {
        body: {
          user_input: user_input,
          known_language,
          learning_language
        }
      });

      if (error) throw error;

      // Create the card data object
      const cardData = {
        front_text: data.card.front_text,
        back_text: data.card.back_text,
        front_lang: data.card.front_lang || known_language,
        back_lang: data.card.back_lang || learning_language,
        front_audio_path: data.card.front_audio_path,
        back_audio_path: data.card.back_audio_path
      };

      // Call onProgress with the text data if the callback exists
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'text',
          data: cardData
        });
      }

      // Return the generated card data
      return cardData;
    } catch (err) {
      console.error('Error generating card:', err);
      throw new Error(`Card generation failed: ${err.message}`);
    }
  }

  async regenerateCardPart(currentCard, parts = [], known_language, learning_language, onProgress) {
    try {
      // Call Supabase function to regenerate specific parts of the card
      const { data, error } = await this.supabase.functions.invoke('cards', {
        body: {
          regenerate_parts: parts, // Array of parts to regenerate: ['front_text', 'front_audio_path', 'back_text', 'back_audio_path']
          current_card: currentCard, // The current card data to use for non-regenerated parts
          known_language,
          learning_language
        }
      });

      if (error) throw error;

      // Create the updated card data object
      const cardData = {
        front_text: data.card.front_text,
        back_text: data.card.back_text,
        front_lang: data.card.front_lang || known_language,
        back_lang: data.card.back_lang || learning_language,
        front_audio_path: data.card.front_audio_path,
        back_audio_path: data.card.back_audio_path
      };

      // Call onProgress with the text data if the callback exists
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'text',
          data: cardData
        });
      }

      // Return the updated card data
      return cardData;
    } catch (err) {
      console.error('Error regenerating card part:', err);
      throw new Error(`Card part regeneration failed: ${err.message}`);
    }
  }

  async evaluateSpeech(audio_blob, expected_text, back_lang, expected_audio_blob, front_lang) {
    console.log('SupabaseApi: Evaluating speech with front_lang:', front_lang);
    try {
      const [userAudioBase64, expectedAudioBase64] = await Promise.all([
        blobToBase64(audio_blob),
        blobToBase64(expected_audio_blob)
      ]);
      console.log('SupabaseApi: Evaluating speech with front_lang:', front_lang);

      const { data, error } = await this.supabase.functions.invoke('speech', {
        body: {
          audio_base64: userAudioBase64,
          expected_text,
          back_lang,
          expected_audio_base64: expectedAudioBase64,
          audio_format: 'mp3',
          front_lang
        },
      });

      if (error) {
        throw new Error('Failed to evaluate speech: ' + error.message);
      }

      return data;
    } catch (err) {
      throw new Error('Failed to evaluate speech: ' + err.message);
    }
  }

  clear() {
    // Clean up any resources if needed
  }
}

// Single API instance
let apiInstance = null;

// Helper function to get the API instance
const getApiInstance = () => {
  if (!apiInstance) {
    apiInstance = new SupabaseApi();
  }
  return apiInstance;
};

// API mode management
export const clearApiInstance = () => {
  if (apiInstance) {
    apiInstance.clear();
    apiInstance = null;
  }
};

// API Functions
export const generateCard = async (user_input, known_language, learning_language, onProgress) => {
  const api = getApiInstance();
  return api.generateCard(user_input, known_language, learning_language, onProgress);
};

export const regenerateCardPart = async (currentCard, parts, known_language, learning_language, onProgress) => {
  const api = getApiInstance();
  return api.regenerateCardPart(currentCard, parts, known_language, learning_language, onProgress);
};

export const evaluateSpeech = async (audio_blob, expected_text, back_lang, expected_audio_blob, front_lang) => {
  console.log('API: Evaluating speech with front_lang:', front_lang);
  const api = getApiInstance();
  return api.evaluateSpeech(audio_blob, expected_text, back_lang, expected_audio_blob, front_lang);
};

export const getRealtimeToken = async () => {
  const api = getApiInstance();
  return api.getRealtimeToken();
}; 