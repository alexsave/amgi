// Network API operations
import { SupabaseApi } from './apiImplementations/SupabaseApi';

// API instance management
let apiInstance = null;

// Helper function to get the appropriate API implementation
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