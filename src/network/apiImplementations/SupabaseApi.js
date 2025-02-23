import { ApiInterface } from './ApiInterface';
import { blobToBase64 } from '../utils';
import supabaseClient from '../../db/supabaseClient';

export class SupabaseApi extends ApiInterface {
  constructor() {
    super();
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
      const card = {
        ...data.card,
        frontLang: data.card.frontLang,
        backLang: data.card.backLang,
        frontAudioUrl: data.card.frontAudioUrl,
        backAudioUrl: data.card.backAudioUrl
      };
      console.log('SupabaseApi: Received card data:', {
        front_text: card.front_text,
        back_text: card.back_text,
        frontLang: card.frontLang,
        backLang: card.backLang,
        frontAudioUrl: card.frontAudioUrl,
        backAudioUrl: card.backAudioUrl
      });
      onProgress({ type: 'text', data: card });

      // Handle the audio URLs
      if (card.frontAudioUrl) {
        onProgress({ type: 'audio', side: 'front', url: card.frontAudioUrl });
      }

      if (card.backAudioUrl) {
        onProgress({ type: 'audio', side: 'back', url: card.backAudioUrl });
      }

      return {
        card,
        audioReady: {
          front: !!card.frontAudioUrl,
          back: !!card.backAudioUrl
        }
      };
    } catch (err) {
      console.error('Error in SupabaseApi.generateCard:', err);
      throw new Error('Failed to generate card: ' + err.message);
    }
  }

  async evaluateSpeech(audioBlob, expectedText, sourceLang, expectedAudioBlob, targetLang) {
    console.log('SupabaseApi: Evaluating speech with targetLang:', targetLang);
    try {
      const [userAudioBase64, expectedAudioBase64] = await Promise.all([
        blobToBase64(audioBlob),
        blobToBase64(expectedAudioBlob)
      ]);
      console.log('SupabaseApi: Evaluating speech with targetLang:', targetLang);

      const { data, error } = await this.supabase.functions.invoke('speech', {
        body: {
          audioBase64: userAudioBase64,
          expectedText,
          sourceLang,
          expectedAudioBase64,
          audioFormat: 'mp3',
          targetLang
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