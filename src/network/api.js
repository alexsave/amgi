// Network API operations
import * as directApi from './directApi';

// API Configuration
const USE_LOCAL = process.env.REACT_APP_USE_LOCAL === 'true';
const USE_DIRECT_API = localStorage.getItem('USE_DIRECT_API') === 'true';

const LOCAL_CONFIG = {
    baseUrl: 'http://localhost:8000',
    headers: {
        'Content-Type': 'application/json'
    },
    endpoints: {
        realtimeToken: '/api/realtime-token',
        generateCards: '/api/generate_cards',
        evaluateSpeech: '/api/evaluate_speech'
    }
};

const SUPABASE_CONFIG = {
    baseUrl: process.env.REACT_APP_SUPABASE_URL,
    headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.REACT_APP_SUPABASE_KEY
    },
    endpoints: {
        realtimeToken: '/functions/v1/realtime',
        generateCards: '/functions/v1/cards',
        evaluateSpeech: '/functions/v1/speech'
    }
};

const API_CONFIG = USE_LOCAL ? LOCAL_CONFIG : SUPABASE_CONFIG;

// Helper function to get full URL for an endpoint
const getEndpointUrl = (endpoint) => `${API_CONFIG.baseUrl}${API_CONFIG.endpoints[endpoint]}`;

// Helper function to get headers for a request
const getHeaders = () => ({ ...API_CONFIG.headers });

// API mode management
export const setApiMode = (useDirectApi, apiKey = null) => {
  if (useDirectApi && apiKey) {
    localStorage.setItem('USE_DIRECT_API', 'true');
    directApi.initializeOpenAI(apiKey);
  } else {
    localStorage.setItem('USE_DIRECT_API', 'false');
    directApi.clearOpenAI();
  }
};

export const getApiMode = () => ({
  useDirectApi: USE_DIRECT_API,
  apiKey: USE_DIRECT_API ? directApi.getStoredApiKey() : null
});

// API Functions
export const getRealtimeToken = async () => {
  if (USE_DIRECT_API) {
    return directApi.getRealtimeToken();
  }

  console.log('Requesting realtime token...');
  const response = await fetch(getEndpointUrl('realtimeToken'), {
    headers: getHeaders()
  });
  if (!response.ok) {
    const error = `Failed to get token: ${response.statusText}`;
    console.error(error);
    throw new Error(error);
  }
  const data = await response.json();
  console.log('Got token response:', data);
  if (!data.client_secret?.value) {
    const error = 'Invalid token response';
    console.error(error, data);
    throw new Error(error);
  }
  console.log('Successfully extracted token');
  return data.client_secret.value;
};

export const generateCard = async (userInput, targetLang, onProgress) => {
  if (USE_DIRECT_API) {
    return directApi.generateCard({ userInput, targetLang }, onProgress);
  }

  try {
    const response = await fetch(getEndpointUrl('generateCards'), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        userInput,
        targetLang,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to generate card');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let card = null;
    let audioReady = { front: false, back: false };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const data = JSON.parse(line);
        
        if (data.type === 'card') {
          card = data.data;
          onProgress({ type: 'text', data: card });
        } else if (data.type === 'audio') {
          const audioData = new Uint8Array(data.data);
          const blob = new Blob([audioData], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          
          audioReady[data.side] = true;
          onProgress({ type: 'audio', side: data.side, url });
        }
      }
    }

    return { card, audioReady };
  } catch (err) {
    console.error('Error in generateCard:', err);
    throw err;
  }
};

export const evaluateSpeech = async (audioBlob, expectedText, sourceLang, expectedAudioBlob) => {
  try {
    const [userAudioBase64, expectedAudioBase64] = await Promise.all([
      blobToBase64(audioBlob),
      blobToBase64(expectedAudioBlob)
    ]);

    if (USE_DIRECT_API) {
      return directApi.evaluateSpeech({
        audioBase64: userAudioBase64,
        expectedText,
        sourceLang,
        expectedAudioBase64,
      });
    }

    const response = await fetch(getEndpointUrl('evaluateSpeech'), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        audioBase64: userAudioBase64,
        expectedText,
        sourceLang,
        expectedAudioBase64,
        audioFormat: 'mp3'
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error('Failed to evaluate speech: ' + (errorData.error || 'Unknown error'));
    }

    return await response.json();
  } catch (err) {
    console.error('Error evaluating speech:', err);
    throw err;
  }
};

const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}; 