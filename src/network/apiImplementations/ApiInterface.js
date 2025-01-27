// Interface for API implementations
export class ApiInterface {
  async generateCard(userInput, targetLang, onProgress) {
    throw new Error('Not implemented');
  }

  async evaluateSpeech(audioBlob, expectedText, sourceLang, expectedAudioBlob) {
    throw new Error('Not implemented');
  }

  async getRealtimeToken() {
    throw new Error('Not implemented');
  }
} 