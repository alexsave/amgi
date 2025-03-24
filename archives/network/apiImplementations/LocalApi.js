import { ApiInterface } from './ApiInterface';
import { blobToBase64 } from '../utils';

export class LocalApi extends ApiInterface {
  constructor() {
    super();
    this.baseUrl = 'http://localhost:8000';
  }

  async generateCard(user_input, known_language, learning_language, onProgress) {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate_cards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_input: user_input,
          known_language,
          learning_language,
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

  async evaluateSpeech(audio_blob, expected_text, back_lang, expected_audio_blob) {
    try {
      const [userAudioBase64, expectedAudioBase64] = await Promise.all([
        blobToBase64(audio_blob),
        blobToBase64(expected_audio_blob)
      ]);

      const response = await fetch(`${this.baseUrl}/api/evaluate_speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_base64: userAudioBase64,
          expected_text,
          back_lang,
          expected_audio_base64: expectedAudioBase64,
          audio_format: 'mp3'
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
      const response = await fetch(`${this.baseUrl}/api/realtime-token`, {
        headers: {
          'Content-Type': 'application/json',
        }
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