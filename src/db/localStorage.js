// Local storage database operations

const STORAGE_KEYS = {
  DECKS: 'decks',
  CURRENT_DECK: 'currentDeck',
  NEW_CARDS_TODAY: 'newCardsToday',
  LAST_REVIEW_DATE: 'lastReviewDate',
  AUDIO_STORAGE_PREFIX: 'audio_storage/'
};

export const loadDecks = () => {
  try {
    const savedDecks = localStorage.getItem(STORAGE_KEYS.DECKS);
    return savedDecks ? JSON.parse(savedDecks) : {};
  } catch (err) {
    console.error('Error loading decks:', err);
    return {};
  }
};

export const saveDecks = (decks) => {
  try {
    localStorage.setItem(STORAGE_KEYS.DECKS, JSON.stringify(decks));
  } catch (err) {
    console.error('Error saving decks:', err);
  }
};

export const loadCurrentDeck = () => {
  return localStorage.getItem(STORAGE_KEYS.CURRENT_DECK);
};

export const saveCurrentDeck = (deckId) => {
  localStorage.setItem(STORAGE_KEYS.CURRENT_DECK, deckId);
};

export const loadNewCardsToday = () => {
  return parseInt(localStorage.getItem(STORAGE_KEYS.NEW_CARDS_TODAY) || '0', 10);
};

export const saveNewCardsToday = (count) => {
  localStorage.setItem(STORAGE_KEYS.NEW_CARDS_TODAY, count.toString());
};

export const loadLastReviewDate = () => {
  return localStorage.getItem(STORAGE_KEYS.LAST_REVIEW_DATE);
};

export const saveLastReviewDate = (date) => {
  localStorage.setItem(STORAGE_KEYS.LAST_REVIEW_DATE, date);
};

export const resetDailyCounters = () => {
  const today = new Date().toISOString().split('T')[0];
  const lastReviewDate = loadLastReviewDate();
  
  if (lastReviewDate !== today) {
    saveNewCardsToday(0);
    saveLastReviewDate(today);
    return true;
  }
  return false;
};

// Audio storage operations
export const saveAudio = (blob, type) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result;
      const audioId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessionStorage.setItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`, JSON.stringify({
        data: base64data,
        type,
        createdAt: Date.now()
      }));
      resolve(audioId);
    };
    reader.readAsDataURL(blob);
  });
};

export const loadAudio = (audioId) => {
  try {
    const audioData = JSON.parse(sessionStorage.getItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`));
    if (!audioData) return null;
    return audioData;
  } catch (err) {
    console.error('Error loading audio:', err);
    return null;
  }
};

export const deleteAudio = (audioId) => {
  try {
    sessionStorage.removeItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`);
  } catch (err) {
    console.error('Error deleting audio:', err);
  }
};

export const cleanupOldAudio = () => {
  try {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    // Get all audio storage keys
    const audioKeys = Object.keys(sessionStorage).filter(key => 
      key.startsWith(STORAGE_KEYS.AUDIO_STORAGE_PREFIX)
    );
    
    // Remove old audio files
    audioKeys.forEach(key => {
      try {
        const audioData = JSON.parse(sessionStorage.getItem(key));
        if (now - audioData.createdAt > maxAge) {
          sessionStorage.removeItem(key);
        }
      } catch (err) {
        console.error('Error cleaning up audio:', err);
      }
    });
  } catch (err) {
    console.error('Error in audio cleanup:', err);
  }
}; 