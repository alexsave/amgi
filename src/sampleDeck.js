export const sampleDeck = {
  name: "Korean Vocabulary",
  cards: [
    // New card (never reviewed)
    {
      created: Date.now() - 1000,
      front_text: "Hello",
      back_text: "안녕하세요",
      interval: 1,
      easeFactor: 2.5,
      repetitions: 0,
      lastReviewed: null,
      nextReview: null,
      sourceLang: 'en',
      targetLang: 'ko'
    },

    // Card due today with 1 week interval
    {
      created: Date.now() - 2000,
      front_text: "Thank you",
      back_text: "감사합니다",
      interval: 7, // 1 week
      easeFactor: 2.5,
      repetitions: 3,
      lastReviewed: new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString(), // 7 days ago
      nextReview: new Date().toISOString(), // due today
      sourceLang: 'en',
      targetLang: 'ko'
    }
  ],
  created: Date.now(),
  lastModified: Date.now()
}; 