import { ApiInterface } from './ApiInterface';
import { blobToBase64 } from '../utils';
import { createClient } from '@supabase/supabase-js';

export class SupabaseApi extends ApiInterface {
  constructor(supabaseUrl, supabaseKey) {
    super();
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.baseUrl = supabaseUrl;
  }

  async getHeaders() {
    const { data: { session }, error } = await this.supabase.auth.getSession();
    if (error) throw error;
    
    return {
      'Authorization': `Bearer ${session?.access_token}`,
      'Content-Type': 'application/json',
    };
  }

  async generateCard(userInput, targetLang, onProgress) {
    try {
      // Call the card generation function using the SDK
      const { data, error } = await this.supabase.functions.invoke('cards', {
        body: {
          userInput,
          targetLang,
        }
      });

      if (error) {
        throw error;
      }

      // Since we can't stream, we'll get all the data at once
      // First handle the card data
      const card = data.card;
      onProgress({ type: 'text', data: card });

      // Then handle the audio data
      if (data.frontAudio) {
        const frontAudioBlob = new Blob([new Uint8Array(data.frontAudio)], { type: 'audio/mpeg' });
        const frontUrl = URL.createObjectURL(frontAudioBlob);
        onProgress({ type: 'audio', side: 'front', url: frontUrl });
      }

      if (data.backAudio) {
        const backAudioBlob = new Blob([new Uint8Array(data.backAudio)], { type: 'audio/mpeg' });
        const backUrl = URL.createObjectURL(backAudioBlob);
        onProgress({ type: 'audio', side: 'back', url: backUrl });
      }

      return {
        card,
        audioReady: {
          front: !!data.frontAudio,
          back: !!data.backAudio
        }
      };
    } catch (err) {
      console.error('Error in SupabaseApi.generateCard:', err);
      throw new Error('Failed to generate card: ' + err.message);
    }
  }

  async evaluateSpeech(audioBlob, expectedText, sourceLang, expectedAudioBlob) {
    try {
      const [userAudioBase64, expectedAudioBase64] = await Promise.all([
        blobToBase64(audioBlob),
        blobToBase64(expectedAudioBlob)
      ]);

      const { data, error } = await this.supabase.functions.invoke('speech', {
        body: {
          audioBase64: userAudioBase64,
          expectedText,
          sourceLang,
          expectedAudioBase64,
          audioFormat: 'mp3'
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

  async getRealtimeToken() {
    try {
      const { data, error } = await this.supabase.functions.invoke('realtime');

      if (error) {
        throw new Error('Failed to get realtime token: ' + error.message);
      }

      if (!data.client_secret?.value) {
        throw new Error('Invalid token response');
      }

      return data.client_secret.value;
    } catch (error) {
      throw new Error('Failed to get realtime token: ' + error.message);
    }
  }
} 