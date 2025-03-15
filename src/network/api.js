// Network API operations
import { DirectApi } from './apiImplementations/DirectApi';
import { LocalApi } from './apiImplementations/LocalApi';
import { SupabaseApi } from './apiImplementations/SupabaseApi';

// Environment configuration
const USE_LOCAL = process.env.REACT_APP_USE_LOCAL === 'true';

// API instance management
let apiInstance = null;

// Helper function to check if direct API mode is enabled
const isDirectApiEnabled = () => localStorage.getItem('useDirectApi') === 'true';

// Helper function to get the appropriate API implementation
const getApiInstance = () => {
  if (!apiInstance) {
    if (isDirectApiEnabled()) {
      apiInstance = new DirectApi();
      // No need to manually initialize with API key here,
      // as DirectApi will attempt to load it from localStorage in its constructor
      if (!apiInstance.isInitialized()) {
        throw new Error('OpenAI API key not found');
      }
    } else if (USE_LOCAL) {
      apiInstance = new LocalApi();
    } else {
      apiInstance = new SupabaseApi();
    }
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

// Export the getStoredApiKey function from DirectApi for convenience
export const getStoredApiKey = () => {
  const directApi = new DirectApi();
  return directApi.getStoredApiKey();
}; 