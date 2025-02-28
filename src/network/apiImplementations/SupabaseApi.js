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

  async generateCard(userInput, knownLanguage, learningLanguage, onProgress) {
    try {
      // Call the card generation function using the SDK
      const { data, error } = await this.supabase.functions.invoke('cards', {
        body: {
          userInput,
          knownLanguage,
          learningLanguage
        }
      });

      if (error) {
        throw error;
      }

      // Since we can't stream, we'll get all the data at once
      // First handle the card data
      const card = {
        ...data.card,
        frontLang: data.card.frontLang || knownLanguage,
        backLang: data.card.backLang || learningLanguage,
        frontAudioPath: data.card.frontAudioPath,
        backAudioPath: data.card.backAudioPath
      };
      console.log('SupabaseApi: Received card data:', {
        front_text: card.front_text,
        back_text: card.back_text,
        frontLang: card.frontLang,
        backLang: card.backLang,
        frontAudioPath: card.frontAudioPath,
        backAudioPath: card.backAudioPath
      });
      onProgress({ type: 'text', data: card });

      // Handle the audio URLs
      if (card.frontAudioPath) {
        onProgress({ type: 'audio', side: 'front', url: card.frontAudioPath });
      }

      if (card.backAudioPath) {
        onProgress({ type: 'audio', side: 'back', url: card.backAudioPath });
      }

      return {
        card,
        audioReady: {
          front: !!card.frontAudioPath,
          back: !!card.backAudioPath
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