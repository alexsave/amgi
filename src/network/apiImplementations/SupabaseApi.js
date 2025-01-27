import { ApiInterface } from './ApiInterface';
import { blobToBase64 } from '../utils';

export class SupabaseApi extends ApiInterface {
  constructor(supabaseUrl, supabaseKey) {
    super();
    this.baseUrl = supabaseUrl;
    this.apiKey = supabaseKey;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'apikey': this.apiKey
    };
  }

  async generateCard(userInput, targetLang, onProgress) {
    try {
      const response = await fetch(`${this.baseUrl}/functions/v1/cards`, {
        method: 'POST',
        headers: this.getHeaders(),
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
      throw new Error('Failed to generate card: ' + err.message);
    }
  }

  async evaluateSpeech(audioBlob, expectedText, sourceLang, expectedAudioBlob) {
    try {
      const [userAudioBase64, expectedAudioBase64] = await Promise.all([
        blobToBase64(audioBlob),
        blobToBase64(expectedAudioBlob)
      ]);

      const response = await fetch(`${this.baseUrl}/functions/v1/speech`, {
        method: 'POST',
        headers: this.getHeaders(),
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
      throw new Error('Failed to evaluate speech: ' + err.message);
    }
  }

  async getRealtimeToken() {
    try {
      const response = await fetch(`${this.baseUrl}/functions/v1/realtime`, {
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to get token: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data.client_secret?.value) {
        throw new Error('Invalid token response');
      }

      return data.client_secret.value;
    } catch (error) {
      throw new Error('Failed to get realtime token: ' + error.message);
    }
  }
} 