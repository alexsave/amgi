/**
 * Language definitions for the application
 * Each language has a code, name, and flag emoji
 */
export const LANGUAGES = {
  en: { name: 'English', flag: '🇺🇸' },
  ko: { name: 'Korean', flag: '🇰🇷' },
  ja: { name: 'Japanese', flag: '🇯🇵' },
  zh: { name: 'Chinese', flag: '🇨🇳' },
  es: { name: 'Spanish', flag: '🇪🇸' },
  de: { name: 'German', flag: '🇩🇪' },
  it: { name: 'Italian', flag: '🇮🇹' },
  ru: { name: 'Russian', flag: '🇷🇺' },
};

// Helper function to get language display info
export const getLanguageDisplay = (langCode) => {
  return LANGUAGES[langCode] || { name: langCode, flag: '🌍' };
};

export default LANGUAGES;
