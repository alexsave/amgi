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
  console.log('localStorage: Saving audio blob:', {
    size: blob.size,
    type: type
  });

  // Ensure we're dealing with MP3 audio
  if (!type.includes('audio/')) {
    console.error('localStorage: Invalid audio type:', type);
    throw new Error('Invalid audio type');
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result;
      console.log('localStorage: Converted to base64:', {
        length: base64data.length,
        prefix: base64data.substring(0, 50)
      });

      const audioId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const audioData = {
        data: base64data,
        type: 'audio/mp3', // Force MP3 type
        createdAt: Date.now()
      };

      console.log('localStorage: Storing audio data:', {
        id: audioId,
        type: audioData.type,
        dataLength: audioData.data.length
      });

      localStorage.setItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`, JSON.stringify(audioData));
      resolve(audioId);
    };
    reader.readAsDataURL(blob);
  });
};

export const loadAudio = (audioId) => {
  try {
    console.log('localStorage: Loading audio:', audioId);
    const audioData = JSON.parse(localStorage.getItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`));
    if (!audioData) {
      console.warn('localStorage: No audio data found for ID:', audioId);
      return null;
    }

    console.log('localStorage: Loaded audio data:', {
      type: audioData.type,
      dataLength: audioData.data.length,
      createdAt: new Date(audioData.createdAt).toISOString()
    });

    return audioData;
  } catch (err) {
    console.error('localStorage: Error loading audio:', err);
    return null;
  }
};

export const deleteAudio = (audioId) => {
  try {
    localStorage.removeItem(`${STORAGE_KEYS.AUDIO_STORAGE_PREFIX}${audioId}`);
  } catch (err) {
    console.error('Error deleting audio:', err);
  }
};

export const cleanupOldAudio = () => {
  try {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    // Get all audio storage keys
    const audioKeys = Object.keys(localStorage).filter(key => 
      key.startsWith(STORAGE_KEYS.AUDIO_STORAGE_PREFIX)
    );
    
    // Remove old audio files
    audioKeys.forEach(key => {
      try {
        const audioData = JSON.parse(localStorage.getItem(key));
        if (now - audioData.createdAt > maxAge) {
          localStorage.removeItem(key);
        }
      } catch (err) {
        console.error('Error cleaning up audio:', err);
      }
    });
  } catch (err) {
    console.error('Error in audio cleanup:', err);
  }
}; 