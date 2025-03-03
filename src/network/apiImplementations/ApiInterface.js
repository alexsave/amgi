// Interface for API implementations
export class ApiInterface {
  async generateCard(user_input, known_language, learning_language, onProgress) {
    throw new Error('Not implemented');
  }

  async regenerateCardPart(currentCard, parts, known_language, learning_language, onProgress) {
    throw new Error('Not implemented');
  }

  async evaluateSpeech(audio_blob, expected_text, back_lang, expected_audio_blob, front_lang) {
    throw new Error('Not implemented');
  }

  async getRealtimeToken() {
    throw new Error('Not implemented');
  }
} 