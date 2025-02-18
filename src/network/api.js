// Network API operations
import { DirectApi } from './apiImplementations/DirectApi';
import { LocalApi } from './apiImplementations/LocalApi';
import { SupabaseApi } from './apiImplementations/SupabaseApi';

// Environment configuration
const USE_LOCAL = process.env.REACT_APP_USE_LOCAL === 'true';
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY = process.env.REACT_APP_SUPABASE_KEY;

// API instance management
let apiInstance = null;

// Helper function to check if direct API mode is enabled
const isDirectApiEnabled = () => localStorage.getItem('useDirectApi') === 'true';

// Helper function to get the appropriate API implementation
const getApiInstance = () => {
  if (!apiInstance) {
    if (isDirectApiEnabled()) {
      apiInstance = new DirectApi();
      const apiKey = localStorage.getItem('OPENAI_KEY');
      if (!apiKey) {
        throw new Error('OpenAI API key not found');
      }
      apiInstance.initialize(apiKey);
    } else if (USE_LOCAL) {
      apiInstance = new LocalApi();
    } else if (SUPABASE_URL && SUPABASE_KEY) {
      apiInstance = new SupabaseApi(SUPABASE_URL, SUPABASE_KEY);
    } else {
      throw new Error('No valid API configuration found');
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
export const generateCard = async (userInput, targetLang, onProgress) => {
  const api = getApiInstance();
  return api.generateCard(userInput, targetLang, onProgress);
};

export const evaluateSpeech = async (audioBlob, expectedText, sourceLang, expectedAudioBlob, targetLang) => {
  console.log('API: Evaluating speech with targetLang:', targetLang);
  const api = getApiInstance();
  return api.evaluateSpeech(audioBlob, expectedText, sourceLang, expectedAudioBlob, targetLang);
};

export const getRealtimeToken = async () => {
  const api = getApiInstance();
  return api.getRealtimeToken();
}; 